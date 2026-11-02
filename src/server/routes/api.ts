import express, { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import type { DB } from '../db.js';
import { badRequest } from '../errors.js';
import { clearSessionCookie, handle, requireUser, sessionToken, setSessionCookie } from '../http.js';
import type { SplitAppOAuthProvider } from '../mcp/oauth.js';
import type { Ctx } from '../services/context.js';
import * as expenses from '../services/expenses.js';
import * as groups from '../services/groups.js';
import * as users from '../services/users.js';

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Ungültige ID.');
  return n;
};

export function apiRouter(db: DB, oauth: SplitAppOAuthProvider): Router {
  const r = Router();
  r.use(express.json({ limit: '200kb' }));

  // Einfacher CSRF-Schutz: schreibende Anfragen müssen diesen Header setzen (kann Cross-Site nicht ohne CORS gesetzt werden).
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-splitapp') !== '1') {
      res.status(403).json({ error: 'Fehlender Header x-splitapp.' });
      return;
    }
    next();
  });

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

  r.get('/config', handle(() => ({ allowRegistration: config.allowRegistration, mcpUrl: config.mcpUrl.href })));

  r.post(
    '/auth/register',
    authLimiter,
    handle(async (req, res) => {
      const user = await users.registerUser(db, req.body ?? {});
      setSessionCookie(res, users.createSession(db, user.id));
      return { user };
    }),
  );

  r.post(
    '/auth/login',
    authLimiter,
    handle(async (req, res) => {
      const user = await users.authenticate(db, req.body?.email, req.body?.password);
      setSessionCookie(res, users.createSession(db, user.id));
      return { user };
    }),
  );

  r.post(
    '/auth/logout',
    handle((req, res) => {
      users.deleteSession(db, sessionToken(req));
      clearSessionCookie(res);
      return { ok: true };
    }),
  );

  // Ab hier nur mit Anmeldung
  r.use(requireUser(db));
  const ctx = (req: Request): Ctx => ({ db, userId: req.user!.id, via: 'web' });

  r.get('/me', handle((req) => ({ user: req.user })));
  r.patch('/me', handle((req) => ({ user: users.updateProfile(db, req.user!.id, req.body ?? {}) })));
  r.post(
    '/me/password',
    handle(async (req) => {
      await users.changePassword(db, req.user!.id, req.body?.current, req.body?.next);
      return { ok: true };
    }),
  );

  // Gruppen
  r.get('/groups', handle((req) => ({ groups: groups.listGroups(ctx(req)) })));
  r.post('/groups', handle((req) => ({ group: groups.createGroup(ctx(req), req.body ?? {}) })));
  r.get('/groups/:id', handle((req) => ({ group: groups.getGroup(ctx(req), id(req.params.id)) })));
  r.patch('/groups/:id', handle((req) => ({ group: groups.updateGroup(ctx(req), id(req.params.id), req.body ?? {}) })));
  r.delete('/groups/:id', handle((req) => void groups.deleteGroup(ctx(req), id(req.params.id))));
  r.post('/groups/:id/leave', handle((req) => void groups.leaveGroup(ctx(req), id(req.params.id))));
  r.post(
    '/groups/:id/invite',
    handle((req) => ({ inviteToken: groups.regenerateInvite(ctx(req), id(req.params.id)) })),
  );
  r.get(
    '/groups/:id/activity',
    handle((req) => ({ activity: groups.listActivity(ctx(req), id(req.params.id), Number(req.query.limit ?? 50)) })),
  );

  // Mitglieder
  r.post('/groups/:id/members', handle((req) => ({ member: groups.addMember(ctx(req), id(req.params.id), req.body?.name) })));
  r.patch(
    '/groups/:id/members/:memberId',
    handle((req) => ({
      member: groups.renameMember(ctx(req), id(req.params.id), id(req.params.memberId), req.body?.name),
    })),
  );
  r.delete(
    '/groups/:id/members/:memberId',
    handle((req) => void groups.removeMember(ctx(req), id(req.params.id), id(req.params.memberId))),
  );

  // Einladungen
  r.get('/invites/:token', handle((req) => ({ invite: groups.getInvite(ctx(req), String(req.params.token)) })));
  r.post(
    '/invites/:token/join',
    handle((req) => ({
      groupId: groups.joinByInvite(ctx(req), String(req.params.token), req.body?.memberId ? id(req.body.memberId) : null),
    })),
  );

  // Ausgaben
  r.get(
    '/groups/:id/expenses',
    handle((req) =>
      expenses.listExpenses(ctx(req), id(req.params.id), {
        query: req.query.q ? String(req.query.q) : undefined,
        onlyDeleted: req.query.deleted === 'only',
        includeDeleted: req.query.deleted === 'include',
        limit: req.query.limit ? Number(req.query.limit) : 100,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      }),
    ),
  );
  r.post('/groups/:id/expenses', handle((req) => ({ expense: expenses.createExpense(ctx(req), id(req.params.id), req.body) })));
  r.post(
    '/groups/:id/payments',
    handle((req) => ({
      expense: expenses.recordPayment(ctx(req), id(req.params.id), {
        fromMemberId: id(req.body?.fromMemberId),
        toMemberId: id(req.body?.toMemberId),
        amount: Number(req.body?.amount),
        currency: req.body?.currency,
        date: req.body?.date,
        notes: req.body?.notes,
      }),
    })),
  );
  r.get('/expenses/:id', handle((req) => ({ expense: expenses.getExpense(ctx(req), id(req.params.id)) })));
  r.patch('/expenses/:id', handle((req) => ({ expense: expenses.updateExpense(ctx(req), id(req.params.id), req.body ?? {}) })));
  r.delete('/expenses/:id', handle((req) => ({ expense: expenses.deleteExpense(ctx(req), id(req.params.id)) })));
  r.post('/expenses/:id/restore', handle((req) => ({ expense: expenses.restoreExpense(ctx(req), id(req.params.id)) })));

  // Verbundene Apps (MCP / OAuth)
  r.get('/connections', handle((req) => ({ connections: oauth.listConnections(req.user!.id), mcpUrl: config.mcpUrl.href })));
  r.delete('/connections/:grantId', handle((req) => void oauth.revokeConnection(req.user!.id, String(req.params.grantId))));

  return r;
}
