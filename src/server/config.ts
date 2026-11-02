import path from 'node:path';
import crypto from 'node:crypto';

const publicUrl = new URL(process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Öffentliche Basis-URL (muss für Claude/ChatGPT per HTTPS erreichbar sein). */
  publicUrl,
  mcpUrl: new URL('/mcp', publicUrl),
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  dbFile: process.env.DB_FILE ?? '',
  webDir: path.resolve(process.env.WEB_DIR ?? 'dist/web'),
  /** Geheimnis für CSRF-Tokens. Wird ohne Angabe pro Prozessstart neu erzeugt. */
  secret: process.env.APP_SECRET ?? crypto.randomBytes(32).toString('hex'),
  secureCookies: publicUrl.protocol === 'https:',
  trustProxy: process.env.TRUST_PROXY ?? (publicUrl.protocol === 'https:' ? '1' : 'loopback'),
  allowRegistration: (process.env.ALLOW_REGISTRATION ?? 'true') !== 'false',
  sessionDays: 60,
  accessTokenSeconds: 60 * 60,
  refreshTokenDays: 90,
};
