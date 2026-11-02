import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoney } from '../../shared/money.js';
import type { User } from '../api.js';

// --- Auth-Kontext -------------------------------------------------------------

export const AuthContext = createContext<{ user: User | null; setUser: (u: User | null) => void }>({
  user: null,
  setUser: () => {},
});
export const useAuth = () => useContext(AuthContext);

// --- Toasts -----------------------------------------------------------------

interface ToastState {
  message: string;
  action?: { label: string; run: () => void };
}
const ToastContext = createContext<(t: ToastState) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number>(undefined);
  const show = useCallback((t: ToastState) => {
    setToast(t);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), t.action ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.action && (
            <button
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

// --- Modal ------------------------------------------------------------------

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Schliessen">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// --- Darstellung --------------------------------------------------------------

export const money = (minor: number, currency: string) => formatMoney(minor, currency);

const COLORS = ['#1f9d6b', '#3b7dd8', '#c2532d', '#8a5cd1', '#d18f1f', '#2a9bb0', '#c23d7a', '#5b8a2a'];
export function Avatar({ name, id }: { name: string; id: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return (
    <span className="avatar" style={{ background: COLORS[id % COLORS.length] }} aria-hidden>
      {initials || '?'}
    </span>
  );
}

/** "Du bekommst CHF 20.00" / "Du schuldest ..." / "Ausgeglichen" */
export function BalanceText({ amount, currency, subject = 'du' }: { amount: number; currency: string; subject?: string }) {
  const you = subject === 'du';
  if (amount === 0) return <span className="muted">ausgeglichen</span>;
  if (amount > 0)
    return (
      <span className="positive">
        {you ? 'bekommst' : 'bekommt'} {money(amount, currency)}
      </span>
    );
  return (
    <span className="negative">
      {you ? 'schuldest' : 'schuldet'} {money(-amount, currency)}
    </span>
  );
}

export function viaLabel(via: string) {
  if (via === 'web') return null;
  if (via.startsWith('mcp:')) return `via ${via.slice(4)}`;
  return `via ${via}`;
}

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString('de-CH', opts);
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('de-CH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error-box">{error instanceof Error ? error.message : String(error)}</div>;
}

export function CopyButton({ text, label = 'Kopieren' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="small"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          window.prompt('Zum Kopieren:', text);
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? '✓ Kopiert' : label}
    </button>
  );
}

/** Lädt Daten und stellt reload() bereit. */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const counter = useRef(0);
  const reload = useCallback(() => {
    const n = ++counter.current;
    setLoading(true);
    load()
      .then((d) => n === counter.current && (setData(d), setError(null)))
      .catch((e) => n === counter.current && setError(e))
      .finally(() => n === counter.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}
