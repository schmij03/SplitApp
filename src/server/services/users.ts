import { config } from '../config.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../crypto.js';
import { nowSeconds, type DB } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import type { Row } from './context.js';

export interface User {
  id: number;
  email: string;
  name: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getUser(db: DB, id: number): User | undefined {
  return db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(id) as User | undefined;
}

export async function registerUser(db: DB, input: { email: string; name: string; password: string }): Promise<User> {
  if (!config.allowRegistration) throw new AppError(403, 'Registrierung ist deaktiviert.');
  const email = input.email?.trim().toLowerCase();
  const name = input.name?.trim();
  if (!email || !EMAIL_RE.test(email)) throw badRequest('Bitte eine gültige E-Mail-Adresse angeben.');
  if (!name || name.length > 60) throw badRequest('Bitte einen Namen (max. 60 Zeichen) angeben.');
  if (!input.password || input.password.length < 8) throw badRequest('Das Passwort muss mindestens 8 Zeichen haben.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new AppError(409, 'Mit dieser E-Mail-Adresse existiert bereits ein Konto.');
  }
  const hash = await hashPassword(input.password);
  const res = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(email, name, hash);
  return { id: Number(res.lastInsertRowid), email, name };
}

export async function authenticate(db: DB, email: string, password: string): Promise<User> {
  const row = db
    .prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
    .get(String(email ?? '').trim().toLowerCase()) as Row | undefined;
  // Auch bei unbekannter E-Mail hashen, damit die Antwortzeit nichts verrät.
  const ok = row
    ? await verifyPassword(String(password ?? ''), row.password_hash)
    : (await hashPassword('dummy-password'), false);
  if (!row || !ok) throw new AppError(401, 'E-Mail oder Passwort ist falsch.');
  return { id: row.id, email: row.email, name: row.name };
}

export function updateProfile(db: DB, userId: number, input: { name?: string }): User {
  const name = input.name?.trim();
  if (!name || name.length > 60) throw badRequest('Bitte einen Namen (max. 60 Zeichen) angeben.');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, userId);
  return getUser(db, userId)!;
}

export async function changePassword(db: DB, userId: number, current: string, next: string): Promise<void> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as Row;
  if (!(await verifyPassword(current ?? '', row.password_hash))) throw badRequest('Das aktuelle Passwort ist falsch.');
  if (!next || next.length < 8) throw badRequest('Das neue Passwort muss mindestens 8 Zeichen haben.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), userId);
}

// --- Web-Sessions ---------------------------------------------------------

export function createSession(db: DB, userId: number): string {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    nowSeconds() + config.sessionDays * 86400,
  );
  return token;
}

export function userForSession(db: DB, token: string | undefined): User | undefined {
  if (!token) return undefined;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), nowSeconds()) as User | undefined;
  return row ? { id: row.id, email: row.email, name: row.name } : undefined;
}

export function deleteSession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
}

export function cleanupExpired(db: DB): void {
  const now = nowSeconds();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM oauth_requests WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now);
}
