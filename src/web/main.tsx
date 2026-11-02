import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, tokenStore, type User } from './api.js';
import { AuthContext, ToastProvider } from './components/ui.js';
import { LoginPage, SignupPage } from './pages/Auth.js';
import { ConnectPage } from './pages/Connect.js';
import { DashboardPage } from './pages/Dashboard.js';
import { GroupPage } from './pages/Group.js';
import { JoinPage } from './pages/Join.js';
import { SettingsPage } from './pages/Settings.js';
import { currentRoute, Link, match, navigate, useLocation } from './router.js';
import './styles.css';

const PUBLIC_PATHS = ['/login', '/signup', '/connect'];

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const { path, query } = useLocation();

  useEffect(() => {
    if (!tokenStore.get()) {
      setUser(null);
      return;
    }
    api<{ user: User }>('GET', '/me')
      .then((r) => setUser(r.user))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) tokenStore.set(null);
        setUser(null);
      });
  }, []);

  useEffect(() => {
    if (user === null && !PUBLIC_PATHS.includes(path)) {
      const here = currentRoute();
      navigate(here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`, true);
    }
    if (user && (path === '/login' || path === '/signup')) {
      if (!query.get('next')) navigate('/', true);
    }
  }, [user, path]);

  if (user === undefined) return null;

  let page;
  let params: Record<string, string> | null;
  if (path === '/login') page = <LoginPage />;
  else if (path === '/signup') page = <SignupPage />;
  else if (path === '/connect') page = <ConnectPage />;
  else if (!user) page = null;
  else if (path === '/') page = <DashboardPage />;
  else if (path === '/settings') page = <SettingsPage />;
  else if ((params = match('/groups/:id', path))) page = <GroupPage key={params.id} id={Number(params.id)} />;
  else if ((params = match('/join/:token', path))) page = <JoinPage token={params.token!} />;
  else page = <div className="empty">Seite nicht gefunden. <Link href="/">Zur Übersicht</Link></div>;

  const nav = (href: string, label: string, cls = '') => (
    <Link href={href} className={`${path === href || (href !== '/' && path.startsWith(href)) ? 'active' : ''} ${cls}`}>
      {label}
    </Link>
  );

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      <ToastProvider>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="logo">
              <span className="logo-mark">÷</span> SplitApp
            </Link>
            <nav className="nav">
              {user ? (
                <>
                  {nav('/', 'Gruppen')}
                  {nav('/connect', 'KI verbinden')}
                  {nav('/settings', user.name.split(' ')[0] ?? 'Konto', 'hide-sm')}
                  {nav('/settings', '⚙️', 'show-sm')}
                </>
              ) : (
                <>
                  {nav('/login', 'Anmelden')}
                  {nav('/signup', 'Registrieren')}
                </>
              )}
            </nav>
          </div>
        </header>
        <main>{page}</main>
      </ToastProvider>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
