/** Server-gerenderte Seite, auf der Benutzer einem MCP-Client (Claude, ChatGPT) Zugriff auf ihr Konto geben. */
import express, { type Request, type Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { hmac } from '../crypto.js';
import type { DB } from '../db.js';
import { AppError } from '../errors.js';
import { clearSessionCookie, currentUser, escapeHtml, sessionToken, setSessionCookie } from '../http.js';
import { authenticate, createSession, deleteSession, type User } from '../services/users.js';
import { safeHost, type PendingAuthorization, type SplitAppOAuthProvider } from './oauth.js';

const csrfFor = (req: Request, requestId: string) => hmac(config.secret, `${sessionToken(req) ?? 'anon'}:${requestId}`);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · SplitApp</title>
<style>
  :root { --bg:#f4f6f5; --card:#fff; --text:#17201b; --muted:#5d6b63; --accent:#1f9d6b; --accent-ink:#fff; --border:#dde3df; --danger:#c2412d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1412; --card:#18201c; --text:#e8eeea; --muted:#9aa8a0; --accent:#35c58d; --accent-ink:#06120c; --border:#2a3530; } }
  * { box-sizing:border-box } body { margin:0; font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:420px; margin:48px auto; padding:0 16px; }
  .brand { font-weight:700; font-size:20px; margin-bottom:16px; display:flex; gap:8px; align-items:center; }
  .brand span { background:var(--accent); color:var(--accent-ink); border-radius:8px; padding:2px 8px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:24px; }
  h1 { font-size:20px; margin:0 0 8px } p { color:var(--muted); margin:8px 0 }
  label { display:block; font-size:14px; margin:12px 0 4px; } input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:transparent; color:inherit; font:inherit; }
  button { font:inherit; border-radius:10px; padding:10px 16px; border:1px solid var(--border); background:transparent; color:inherit; cursor:pointer; }
  button.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); font-weight:600; }
  .row { display:flex; gap:8px; margin-top:20px; } .row button { flex:1 }
  ul { padding-left:20px; color:var(--muted) } .error { color:var(--danger); } .small { font-size:13px } a { color:var(--accent) }
  .linkbtn { border:0; padding:0; color:var(--accent); text-decoration:underline; background:none; font-size:13px; }
</style></head><body><main><div class="brand"><span>÷</span> SplitApp</div><div class="card">${body}</div></main></body></html>`;
}

function clientLabel(p: PendingAuthorization) {
  return escapeHtml(p.client.client_name || 'Eine App');
}

function loginPage(req: Request, p: PendingAuthorization, error?: string) {
  const next = `/oauth/consent?request=${encodeURIComponent(p.id)}`;
  return page(
    'Anmelden',
    `<h1>Bei SplitApp anmelden</h1>
     <p><strong>${clientLabel(p)}</strong> möchte auf dein SplitApp-Konto zugreifen. Melde dich zuerst an.</p>
     ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
     <form method="post" action="/oauth/consent">
       <input type="hidden" name="request" value="${escapeHtml(p.id)}">
       <input type="hidden" name="csrf" value="${csrfFor(req, p.id)}">
       <input type="hidden" name="action" value="login">
       <label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="email" required autofocus>
       <label for="password">Passwort</label><input id="password" name="password" type="password" autocomplete="current-password" required>
       <div class="row"><button class="primary" type="submit">Anmelden</button></div>
     </form>
     <p class="small">Noch kein Konto? <a href="/signup?next=${encodeURIComponent(next)}">Jetzt registrieren</a></p>`,
  );
}

function consentPage(req: Request, p: PendingAuthorization, user: User) {
  const host = safeHost(p.params.redirectUri);
  return page(
    'Zugriff erlauben',
    `<h1>${clientLabel(p)} verbinden?</h1>
     <p>Angemeldet als <strong>${escapeHtml(user.name)}</strong> (${escapeHtml(user.email)})</p>
     <p>${clientLabel(p)} erhält Zugriff auf dein Konto und kann:</p>
     <ul><li>alle deine Gruppen und Salden sehen</li><li>alle Einträge lesen</li><li>Einträge erfassen, ändern und löschen</li></ul>
     ${host ? `<p class="small">Weiterleitung nach: <strong>${escapeHtml(host)}</strong></p>` : ''}
     <form method="post" action="/oauth/consent">
       <input type="hidden" name="request" value="${escapeHtml(p.id)}">
       <input type="hidden" name="csrf" value="${csrfFor(req, p.id)}">
       <div class="row">
         <button type="submit" name="action" value="deny">Ablehnen</button>
         <button class="primary" type="submit" name="action" value="approve">Zugriff erlauben</button>
       </div>
       <p class="small">Du kannst den Zugriff jederzeit unter Einstellungen → Verbundene Apps widerrufen.
       <button class="linkbtn" type="submit" name="action" value="logout">Anderes Konto verwenden</button></p>
     </form>`,
  );
}

const invalidPage = () =>
  page(
    'Ungültige Anfrage',
    `<h1>Anfrage abgelaufen</h1><p>Diese Anmeldeanfrage ist ungültig oder abgelaufen. Bitte starte die Verbindung in Claude bzw. ChatGPT erneut.</p>`,
  );

export function consentRouter(db: DB, provider: SplitAppOAuthProvider): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false });

  router.get('/oauth/consent', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    const pending = provider.getPending(String(req.query.request ?? ''));
    if (!pending) return res.status(400).send(invalidPage());
    const user = currentUser(db, req);
    res.send(user ? consentPage(req, pending, user) : loginPage(req, pending));
  });

  router.post('/oauth/consent', limiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    const pending = provider.getPending(String(req.body.request ?? ''));
    if (!pending) return res.status(400).send(invalidPage());
    if (req.body.csrf !== csrfFor(req, pending.id)) {
      return res.redirect(303, `/oauth/consent?request=${encodeURIComponent(pending.id)}`);
    }
    const back = `/oauth/consent?request=${encodeURIComponent(pending.id)}`;

    switch (req.body.action) {
      case 'login': {
        try {
          const user = await authenticate(db, req.body.email, req.body.password);
          setSessionCookie(res, createSession(db, user.id));
          return res.redirect(303, back);
        } catch (err) {
          const msg = err instanceof AppError ? err.message : 'Anmeldung fehlgeschlagen.';
          return res.status(401).send(loginPage(req, pending, msg));
        }
      }
      case 'logout':
        deleteSession(db, sessionToken(req));
        clearSessionCookie(res);
        return res.redirect(303, back);
      case 'approve': {
        const user = currentUser(db, req);
        if (!user) return res.redirect(303, back);
        return res.redirect(302, provider.approve(pending, user.id));
      }
      case 'deny':
        return res.redirect(302, provider.deny(pending));
      default:
        return res.redirect(303, back);
    }
  });

  return router;
}
