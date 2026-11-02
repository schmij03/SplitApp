/**
 * /authorize: Hier gibt ein Benutzer einem MCP-Client (Claude, ChatGPT, ...) Zugriff auf sein Konto.
 * Die OAuth-Bibliothek prüft Client, Redirect-URI und PKCE; diese Seite erledigt Anmeldung und Zustimmung.
 */
import { AuthorizationError, CimdFetchError, type AuthRequest } from '@cloudflare/workers-oauth-provider';
import { Db } from './db.js';
import type { AuthProps, Env } from './env.js';
import { AppError } from './errors.js';
import { escapeHtml, htmlResponse, page } from './html.js';
import { authenticate, createSession, deleteSession, registerUser, userForSession, type User } from './services/users.js';

export const SESSION_COOKIE = 'splitapp_session';
const SCOPES = ['splitapp'];

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function sessionCookie(token: string | null): string {
  const secure = 'Secure; HttpOnly; SameSite=Lax; Path=/';
  return token ? `${SESSION_COOKIE}=${token}; ${secure}; Max-Age=${60 * 86400}` : `${SESSION_COOKIE}=; ${secure}; Max-Age=0`;
}

const redirect = (location: string, setCookie?: string) => {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(null, { status: 303, headers });
};

function loginPage(action: string, error?: string, mode: 'login' | 'register' = 'login', allowRegistration = true) {
  const form = (m: 'login' | 'register') => `
     <form method="post" action="${escapeHtml(action)}">
       <input type="hidden" name="action" value="${m}">
       ${m === 'register' ? '<label for="name">Name</label><input id="name" name="name" autocomplete="name" required maxlength="60">' : ''}
       <label for="email-${m}">E-Mail</label><input id="email-${m}" name="email" type="email" autocomplete="email" required ${m === mode ? 'autofocus' : ''}>
       <label for="password-${m}">Passwort${m === 'register' ? ' (mind. 8 Zeichen)' : ''}</label>
       <input id="password-${m}" name="password" type="password" autocomplete="${m === 'register' ? 'new-password' : 'current-password'}" required ${m === 'register' ? 'minlength="8"' : ''}>
       <div class="row"><button class="primary" type="submit">${m === 'register' ? 'Konto erstellen' : 'Anmelden'}</button></div>
     </form>`;
  return page(
    'Anmelden',
    `<h1>${mode === 'register' ? 'Konto erstellen' : 'Bei SplitApp anmelden'}</h1>
     <p>Melde dich an, um deinen KI-Assistenten mit SplitApp zu verbinden.</p>
     ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
     ${form(mode)}
     ${allowRegistration ? `<details ${mode === 'register' ? '' : ''}><summary>${mode === 'register' ? 'Ich habe schon ein Konto' : 'Noch kein Konto? Hier registrieren'}</summary>${form(mode === 'register' ? 'login' : 'register')}</details>` : ''}`,
  );
}

const errorPage = (message: string, status = 400) =>
  htmlResponse(page('Fehler', `<h1>Das hat nicht geklappt</h1><p>${escapeHtml(message)}</p><p>Bitte starte die Verbindung in Claude bzw. ChatGPT erneut.</p>`), status);

async function consentPage(env: Env, authReq: AuthRequest, user: User, action: string): Promise<Response> {
  const details = await env.OAUTH_PROVIDER.describeConsent(authReq);
  const consent = await env.OAUTH_PROVIDER.beginConsent(authReq);
  const name = escapeHtml(details.clientName || 'Eine App');
  const html = page(
    'Zugriff erlauben',
    `<h1>${name} verbinden?</h1>
     <p>Angemeldet als <strong>${escapeHtml(user.name)}</strong> (${escapeHtml(user.email)})</p>
     <p>${name} erhält Zugriff auf dein Konto und kann:</p>
     <ul><li>alle deine Gruppen und Salden sehen</li><li>alle Einträge lesen</li><li>Einträge erfassen, ändern und löschen</li></ul>
     <p class="small">${
       details.clientDomain
         ? `Herausgeber: <strong>${escapeHtml(details.clientDomain)}</strong>.`
         : 'Diese App hat sich selbst registriert, ihr Name ist nicht überprüft.'
     } Zugriff geht an: <strong>${escapeHtml(details.redirectHost)}</strong></p>
     ${details.redirectIsLoopback ? '<p class="warn">Der Zugriff geht an ein Programm auf deinem Computer. Fahre nur fort, wenn du die Verbindung gerade selbst gestartet hast.</p>' : ''}
     <form method="post" action="${escapeHtml(action)}">
       <input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
       <div class="row">
         <button type="submit" name="decision" value="deny">Ablehnen</button>
         <button class="primary" type="submit" name="decision" value="approve">Zugriff erlauben</button>
       </div>
     </form>
     <form method="post" action="${escapeHtml(action)}">
       <input type="hidden" name="action" value="logout">
       <p class="small">Du kannst den Zugriff jederzeit in SplitApp unter «KI verbinden» widerrufen.
       <button class="linkbtn" type="submit">Anderes Konto verwenden</button></p>
     </form>`,
  );
  return htmlResponse(html, 200, consent.headers);
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const db = new Db(env.DB);
  const url = new URL(request.url);
  const action = `${url.pathname}${url.search}`;
  const allowRegistration = env.ALLOW_REGISTRATION !== 'false';
  try {
    const session = cookie(request, SESSION_COOKIE);

    if (request.method === 'POST') {
      const form = await request.formData();
      const act = String(form.get('action') ?? '');

      if (act === 'login' || act === 'register') {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        if (env.AUTH_LIMITER && !(await env.AUTH_LIMITER.limit({ key: `authorize:${ip}` })).success) {
          return htmlResponse(loginPage(action, 'Zu viele Versuche. Bitte warte eine Minute.', act, allowRegistration), 429);
        }
        try {
          const user =
            act === 'register'
              ? await registerUser(db, { name: String(form.get('name') ?? ''), email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') }, allowRegistration)
              : await authenticate(db, form.get('email'), form.get('password'));
          return redirect(action, sessionCookie(await createSession(db, user.id)));
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          return htmlResponse(loginPage(action, err.message, act, allowRegistration), err.status);
        }
      }
      if (act === 'logout') {
        await deleteSession(db, session);
        return redirect(action, sessionCookie(null));
      }

      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const user = await userForSession(db, session);
      if (!user) return redirect(action);
      const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: SCOPES });
      const client = await env.OAUTH_PROVIDER.lookupClient(approved.request.clientId);
      const clientName = client?.clientName || 'MCP-Client';
      const props: AuthProps = { userId: user.id, clientName };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: approved.request,
        userId: String(user.id),
        metadata: { clientName, redirectHost: safeHost(approved.request.redirectUri) },
        scope: SCOPES,
        props,
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    // GET: Anfrage prüfen (wirft bei ungültigem Client oder Redirect-URI)
    const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const user = await userForSession(db, session);
    if (!user) return htmlResponse(loginPage(action, undefined, 'login', allowRegistration));
    return await consentPage(env, authReq, user, action);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return errorPage(error.description);
    if (error instanceof CimdFetchError) return errorPage('Diese App konnte nicht überprüft werden.');
    throw error;
  }
}

function safeHost(uri: string | undefined): string | null {
  try {
    return uri ? new URL(uri).host : null;
  } catch {
    return null;
  }
}
