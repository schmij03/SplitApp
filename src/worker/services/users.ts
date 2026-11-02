import { hashPassword, randomToken, sha256, verifyPassword } from '../crypto.js';
import { nowSeconds, type Db, type Row } from '../db.js';
import { AppError, badRequest } from '../errors.js';

export interface User {
  id: number;
  email: string;
  name: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_DAYS = 60;

export async function getUser(db: Db, id: number): Promise<User | undefined> {
  return db.first<User>('SELECT id, email, name FROM users WHERE id = ?', id);
}

export async function registerUser(
  db: Db,
  input: { email?: string; name?: string; password?: string },
  allowRegistration: boolean,
): Promise<User> {
  if (!allowRegistration) throw new AppError(403, 'Registrierung ist deaktiviert.');
  const email = String(input.email ?? '').trim().toLowerCase();
  const name = String(input.name ?? '').trim();
  const password = String(input.password ?? '');
  if (!email || !EMAIL_RE.test(email)) throw badRequest('Bitte eine gültige E-Mail-Adresse angeben.');
  if (!name || name.length > 60) throw badRequest('Bitte einen Namen (max. 60 Zeichen) angeben.');
  if (password.length < 8) throw badRequest('Das Passwort muss mindestens 8 Zeichen haben.');
  if (await db.first('SELECT 1 FROM users WHERE email = ?', email)) {
    throw new AppError(409, 'Mit dieser E-Mail-Adresse existiert bereits ein Konto.');
  }
  const res = await db.run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)', email, name, await hashPassword(password));
  return { id: Number(res.meta.last_row_id), email, name };
}

export async function authenticate(db: Db, email: unknown, password: unknown): Promise<User> {
  const row = await db.first<Row>(
    'SELECT id, email, name, password_hash FROM users WHERE email = ?',
    String(email ?? '').trim().toLowerCase(),
  );
  if (!row || !(await verifyPassword(String(password ?? ''), row.password_hash))) {
    throw new AppError(401, 'E-Mail oder Passwort ist falsch.');
  }
  return { id: row.id, email: row.email, name: row.name };
}

export async function updateProfile(db: Db, userId: number, input: { name?: string }): Promise<User> {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 60) throw badRequest('Bitte einen Namen (max. 60 Zeichen) angeben.');
  await db.run('UPDATE users SET name = ? WHERE id = ?', name, userId);
  return (await getUser(db, userId))!;
}

export async function changePassword(db: Db, userId: number, current: unknown, next: unknown): Promise<void> {
  const row = await db.first<Row>('SELECT password_hash FROM users WHERE id = ?', userId);
  if (!row || !(await verifyPassword(String(current ?? ''), row.password_hash))) {
    throw badRequest('Das aktuelle Passwort ist falsch.');
  }
  if (String(next ?? '').length < 8) throw badRequest('Das neue Passwort muss mindestens 8 Zeichen haben.');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(String(next)), userId);
}

// --- Sessions (Web-App per Bearer-Token, Zustimmungsseite per Cookie) -----------

export async function createSession(db: Db, userId: number): Promise<string> {
  const token = `sa_s_${randomToken()}`;
  await db.batch([
    db.stmt('DELETE FROM sessions WHERE expires_at <= ?', nowSeconds()),
    db.stmt('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256(token), userId, nowSeconds() + SESSION_DAYS * 86400),
  ]);
  return token;
}

export async function userForSession(db: Db, token: string | undefined | null): Promise<User | undefined> {
  if (!token) return undefined;
  return db.first<User>(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
    await sha256(token),
    nowSeconds(),
  );
}

export async function deleteSession(db: Db, token: string | undefined | null): Promise<void> {
  if (token) await db.run('DELETE FROM sessions WHERE id_hash = ?', await sha256(token));
}
