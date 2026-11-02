import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** Wird von der OAuth-Bibliothek für den defaultHandler bereitgestellt. */
  OAUTH_PROVIDER: OAuthHelpers;
  AUTH_LIMITER?: RateLimit;
  /** Adresse der Web-Oberfläche, falls nicht vom Worker selbst ausgeliefert (z. B. GitHub Pages) */
  WEB_URL?: string;
  /** Zusätzliche erlaubte Origins für die Web-API, kommagetrennt (z. B. http://localhost:5173) */
  EXTRA_ORIGINS?: string;
  ALLOW_REGISTRATION?: string;
}

/** Was nach der Zustimmung im Token gespeichert wird (verschlüsselt). */
export interface AuthProps {
  userId: number;
  clientName: string;
}

export function webUrl(env: Env, origin: string): string {
  const url = env.WEB_URL?.trim() || `${origin}/`;
  return url.endsWith('/') ? url : `${url}/`;
}

/** Link in die Web-App (Hash-Routing, damit GitHub Pages ohne Server-Rewrites funktioniert). */
export function appLink(env: Env, origin: string, path: string): string {
  return `${webUrl(env, origin)}#${path}`;
}

export function allowedOrigins(env: Env): string[] {
  const list = (env.EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.WEB_URL) list.push(new URL(env.WEB_URL).origin);
  return list;
}
