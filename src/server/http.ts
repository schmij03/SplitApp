import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import type { DB } from './db.js';
import { AppError, unauthorized } from './errors.js';
import { userForSession, type User } from './services/users.js';

export const SESSION_COOKIE = 'splitapp_session';

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      /* ungültiges Cookie ignorieren */
    }
  }
  return out;
}

export const sessionToken = (req: Request) => parseCookies(req)[SESSION_COOKIE];

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: config.sessionDays * 86400 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies });
}

export function currentUser(db: DB, req: Request): User | undefined {
  return userForSession(db, sessionToken(req));
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

export function requireUser(db: DB) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(db, req);
    if (!user) return next(unauthorized());
    req.user = user;
    next();
  };
}

/** Express-Handler mit async-Unterstützung. */
export const handle =
  (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((result) => {
        if (!res.headersSent) {
          if (result === undefined) res.status(204).end();
          else res.json(result);
        }
      })
      .catch(next);
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err && typeof err === 'object' && 'type' in err && (err as any).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Ungültiges JSON.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler.' });
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
