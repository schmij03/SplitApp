import { useState, type FormEvent } from 'react';
import { api, tokenStore, type User } from '../api.js';
import { ErrorBox, useAuth, useToast } from '../components/ui.js';
import { Link, navigate } from '../router.js';

export function SettingsPage() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { user } = await api<{ user: User }>('PATCH', '/me', { name });
      setUser(user);
      toast({ message: 'Profil gespeichert' });
    } catch (err) {
      setError(err);
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('POST', '/me/password', { current, next });
      setCurrent('');
      setNext('');
      toast({ message: 'Passwort geändert' });
    } catch (err) {
      setError(err);
    }
  }

  async function logout() {
    await api('POST', '/auth/logout').catch(() => {});
    tokenStore.set(null);
    setUser(null);
    navigate('/login', true);
  }

  return (
    <div className="stack">
      <h1>Einstellungen</h1>
      <ErrorBox error={error} />
      <form className="card stack" onSubmit={saveProfile}>
        <h2>Profil</h2>
        <p className="small muted">Angemeldet als {user?.email}</p>
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </label>
        <div>
          <button className="primary">Speichern</button>
        </div>
      </form>
      <form className="card stack" onSubmit={savePassword}>
        <h2>Passwort ändern</h2>
        <div className="grid-2">
          <label className="field">
            Aktuelles Passwort
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label className="field">
            Neues Passwort
            <input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
          </label>
        </div>
        <div>
          <button>Passwort ändern</button>
        </div>
      </form>
      <div className="card row wrap">
        <div style={{ flex: 1 }}>
          <h2>Claude & ChatGPT</h2>
          <p className="small muted">Verbundene KI-Assistenten verwalten und widerrufen.</p>
        </div>
        <Link href="/connect" className="btn">
          Verbundene Apps
        </Link>
      </div>
      <div>
        <button onClick={logout}>Abmelden</button>
      </div>
    </div>
  );
}
