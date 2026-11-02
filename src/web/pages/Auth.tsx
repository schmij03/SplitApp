import { useState, type FormEvent } from 'react';
import { api, tokenStore, type User } from '../api.js';
import { ErrorBox, useAuth } from '../components/ui.js';
import { Link, navigate, useLocation } from '../router.js';

/** Nur interne Pfade als Weiterleitungsziel zulassen. */
export function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function finish(next: string) {
  navigate(next, true);
}

export function LoginPage() {
  const { query } = useLocation();
  const { setUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(query.get('next'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user, token } = await api<{ user: User; token: string }>('POST', '/auth/login', { email, password });
      tokenStore.set(token);
      setUser(user);
      finish(next);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth stack">
      <div className="hero">
        <h1>Willkommen zurück</h1>
        <p>Teile Ausgaben mit Freunden, WG und auf Reisen.</p>
      </div>
      <form className="card stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          E-Mail
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          Passwort
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Anmelden…' : 'Anmelden'}
        </button>
      </form>
      <p className="muted small" style={{ textAlign: 'center' }}>
        Noch kein Konto? <Link href={`/signup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>Registrieren</Link>
      </p>
    </div>
  );
}

export function SignupPage() {
  const { query } = useLocation();
  const { setUser } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(query.get('next'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user, token } = await api<{ user: User; token: string }>('POST', '/auth/register', { name, email, password });
      tokenStore.set(token);
      setUser(user);
      finish(next);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth stack">
      <div className="hero">
        <h1>Konto erstellen</h1>
        <p>Kostenlos, ohne Werbung. Verbindbar mit Claude und ChatGPT.</p>
      </div>
      <form className="card stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Name
          <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
        </label>
        <label className="field">
          E-Mail
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          Passwort (mind. 8 Zeichen)
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Erstellen…' : 'Konto erstellen'}
        </button>
      </form>
      <p className="muted small" style={{ textAlign: 'center' }}>
        Schon registriert? <Link href={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>Anmelden</Link>
      </p>
    </div>
  );
}
