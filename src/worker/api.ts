import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { handleAuthorize } from './authorize.js';
import { Db } from './db.js';
import { allowedOrigins, appLink, type Env } from './env.js';
import { AppError, badRequest, unauthorized } from './errors.js';
import type { Ctx } from './services/context.js';
import * as expenses from './services/expenses.js';
import * as groups from './services/groups.js';
import * as users from './services/users.js';
import type { User } from './services/users.js';

type HonoEnv = { Bindings: Env; Variables: { user: User; db: Db } };

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Ungültige ID.');
  return n;
};

const bearer = (c: Context) => c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];

async function body(c: Context): Promise<Record<string, any>> {
  try {
    return ((await c.req.json()) ?? {}) as Record<string, any>;
  } catch {
    return {};
  }
}

async function limit(c: Context<HonoEnv>, what: string) {
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  if (c.env.AUTH_LIMITER && !(await c.env.AUTH_LIMITER.limit({ key: `${what}:${ip}` })).success) {
    throw new AppError(429, 'Zu viele Versuche. Bitte warte eine Minute.');
  }
}

export const app = new Hono<HonoEnv>();

app.onError((err, c) => {
  if (err instanceof AppError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: 'Interner Fehler.' }, 500);
});

app.get('/', (c) => c.redirect(appLink(c.env, new URL(c.req.url).origin, '/'), 302));
app.get('/healthz', (c) => c.json({ ok: true }));
app.on(['GET', 'POST'], '/authorize', (c) => handleAuthorize(c.req.raw, c.env));

// --- Web-API (für die Oberfläche auf GitHub Pages) -------------------------------------------
const api = new Hono<HonoEnv>();
api.use('*', (c, next) =>
  cors({
    origin: (origin) => (allowedOrigins(c.env).includes(origin) ? origin : null),
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })(c, next),
);
api.use('*', async (c, next) => {
  c.set('db', new Db(c.env.DB));
  await next();
});

api.get('/config', (c) =>
  c.json({ allowRegistration: c.env.ALLOW_REGISTRATION !== 'false', mcpUrl: `${new URL(c.req.url).origin}/mcp` }),
);

api.post('/auth/register', async (c) => {
  await limit(c, 'register');
  const user = await users.registerUser(c.var.db, await body(c), c.env.ALLOW_REGISTRATION !== 'false');
  return c.json({ user, token: await users.createSession(c.var.db, user.id) });
});

api.post('/auth/login', async (c) => {
  await limit(c, 'login');
  const b = await body(c);
  const user = await users.authenticate(c.var.db, b.email, b.password);
  return c.json({ user, token: await users.createSession(c.var.db, user.id) });
});

api.post('/auth/logout', async (c) => {
  await users.deleteSession(c.var.db, bearer(c));
  return c.json({ ok: true });
});

// Ab hier nur mit Anmeldung
api.use('*', async (c, next) => {
  const user = await users.userForSession(c.var.db, bearer(c));
  if (!user) throw unauthorized();
  c.set('user', user);
  await next();
});
const ctx = (c: Context<HonoEnv>): Ctx => ({ db: c.var.db, userId: c.var.user.id, via: 'web' });
const ok = (c: Context) => c.body(null, 204);

api.get('/me', (c) => c.json({ user: c.var.user }));
api.patch('/me', async (c) => c.json({ user: await users.updateProfile(c.var.db, c.var.user.id, await body(c)) }));
api.post('/me/password', async (c) => {
  const b = await body(c);
  await users.changePassword(c.var.db, c.var.user.id, b.current, b.next);
  return c.json({ ok: true });
});

api.get('/groups', async (c) => c.json({ groups: await groups.listGroups(ctx(c)) }));
api.post('/groups', async (c) => c.json({ group: await groups.createGroup(ctx(c), await body(c)) }));
api.get('/groups/:id', async (c) => c.json({ group: await groups.getGroup(ctx(c), id(c.req.param('id'))) }));
api.patch('/groups/:id', async (c) => c.json({ group: await groups.updateGroup(ctx(c), id(c.req.param('id')), await body(c)) }));
api.delete('/groups/:id', async (c) => (await groups.deleteGroup(ctx(c), id(c.req.param('id'))), ok(c)));
api.post('/groups/:id/leave', async (c) => (await groups.leaveGroup(ctx(c), id(c.req.param('id'))), ok(c)));
api.post('/groups/:id/invite', async (c) => c.json({ inviteToken: await groups.regenerateInvite(ctx(c), id(c.req.param('id'))) }));
api.get('/groups/:id/activity', async (c) =>
  c.json({ activity: await groups.listActivity(ctx(c), id(c.req.param('id')), Number(c.req.query('limit') ?? 50)) }),
);

api.post('/groups/:id/members', async (c) =>
  c.json({ member: await groups.addMember(ctx(c), id(c.req.param('id')), (await body(c)).name) }),
);
api.patch('/groups/:id/members/:memberId', async (c) =>
  c.json({ member: await groups.renameMember(ctx(c), id(c.req.param('id')), id(c.req.param('memberId')), (await body(c)).name) }),
);
api.delete('/groups/:id/members/:memberId', async (c) => (
  await groups.removeMember(ctx(c), id(c.req.param('id')), id(c.req.param('memberId'))), ok(c)
));

api.get('/invites/:token', async (c) => c.json({ invite: await groups.getInvite(ctx(c), c.req.param('token')) }));
api.post('/invites/:token/join', async (c) => {
  const b = await body(c);
  return c.json({ groupId: await groups.joinByInvite(ctx(c), c.req.param('token'), b.memberId ? id(b.memberId) : null) });
});

api.get('/groups/:id/expenses', async (c) =>
  c.json(
    await expenses.listExpenses(ctx(c), id(c.req.param('id')), {
      query: c.req.query('q') || undefined,
      onlyDeleted: c.req.query('deleted') === 'only',
      includeDeleted: c.req.query('deleted') === 'include',
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : 100,
      offset: c.req.query('offset') ? Number(c.req.query('offset')) : 0,
    }),
  ),
);
api.post('/groups/:id/expenses', async (c) =>
  c.json({ expense: await expenses.createExpense(ctx(c), id(c.req.param('id')), (await body(c)) as any) }),
);
api.post('/groups/:id/payments', async (c) => {
  const b = await body(c);
  return c.json({
    expense: await expenses.recordPayment(ctx(c), id(c.req.param('id')), {
      fromMemberId: id(b.fromMemberId),
      toMemberId: id(b.toMemberId),
      amount: Number(b.amount),
      currency: b.currency,
      date: b.date,
      notes: b.notes,
    }),
  });
});
api.get('/expenses/:id', async (c) => c.json({ expense: await expenses.getExpense(ctx(c), id(c.req.param('id'))) }));
api.patch('/expenses/:id', async (c) =>
  c.json({ expense: await expenses.updateExpense(ctx(c), id(c.req.param('id')), (await body(c)) as any) }),
);
api.delete('/expenses/:id', async (c) => c.json({ expense: await expenses.deleteExpense(ctx(c), id(c.req.param('id'))) }));
api.post('/expenses/:id/restore', async (c) => c.json({ expense: await expenses.restoreExpense(ctx(c), id(c.req.param('id'))) }));

// Verbundene KI-Apps (OAuth-Grants)
api.get('/connections', async (c) => {
  const grants = await c.env.OAUTH_PROVIDER.listUserGrants(String(c.var.user.id));
  return c.json({
    mcpUrl: `${new URL(c.req.url).origin}/mcp`,
    connections: grants.items.map((g) => ({
      id: g.id,
      clientName: (g.metadata as any)?.clientName ?? 'Unbekannte App',
      redirectHost: (g.metadata as any)?.redirectHost ?? null,
      connectedAt: new Date(g.createdAt * 1000).toISOString(),
      expiresAt: g.expiresAt ? new Date(g.expiresAt * 1000).toISOString() : null,
    })),
  });
});
api.delete('/connections/:grantId', async (c) => {
  await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param('grantId'), String(c.var.user.id));
  return ok(c);
});

api.all('*', (c) => c.json({ error: 'Nicht gefunden.' }, 404));
app.route('/api', api);
