import { useState, type FormEvent } from 'react';
import { api, type GroupDetail, type GroupSummary } from '../api.js';
import { BalanceText, ErrorBox, Modal, money, useLoader } from '../components/ui.js';
import { Link, navigate } from '../router.js';

export function DashboardPage() {
  const { data, error, loading } = useLoader(() => api<{ groups: GroupSummary[] }>('GET', '/groups'), []);
  const [creating, setCreating] = useState(false);
  const groups = data?.groups ?? [];

  const totals = new Map<string, { owed: number; owe: number }>();
  for (const g of groups) {
    for (const b of g.myBalance) {
      const t = totals.get(b.currency) ?? { owed: 0, owe: 0 };
      if (b.amount > 0) t.owed += b.amount;
      else t.owe += -b.amount;
      totals.set(b.currency, t);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Übersicht</h1>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>
          + Neue Gruppe
        </button>
      </div>
      <ErrorBox error={error} />

      {totals.size > 0 && (
        <div className="summary">
          {[...totals].map(([currency, t]) => (
            <div key={currency} className="stat">
              <div className="label">Gesamtsaldo {currency}</div>
              <div className={`value ${t.owed - t.owe >= 0 ? 'positive' : 'negative'}`}>
                {t.owed - t.owe >= 0 ? '+' : '−'}
                {money(Math.abs(t.owed - t.owe), currency)}
              </div>
              <div className="small muted">
                Dir geschuldet {money(t.owed, currency)} · Du schuldest {money(t.owe, currency)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card flush">
        {loading && !data ? (
          <div className="empty">Laden…</div>
        ) : groups.length === 0 ? (
          <div className="empty">
            <div className="big">👋</div>
            <p>Noch keine Gruppen. Erstelle eine Gruppe für deine WG, Ferien oder einen Ausflug.</p>
            <p style={{ marginTop: 16 }}>
              <button className="primary" onClick={() => setCreating(true)}>
                Erste Gruppe erstellen
              </button>
            </p>
          </div>
        ) : (
          <div className="list">
            {groups.map((g) => (
              <Link key={g.id} href={`/groups/${g.id}`} className="list-item">
                <span className="icon-badge">👥</span>
                <span className="grow">
                  <div className="title">{g.name}</div>
                  <div className="small muted">
                    {g.memberCount} {g.memberCount === 1 ? 'Mitglied' : 'Mitglieder'} · {g.currency}
                  </div>
                </span>
                <span className="right">
                  {g.myBalance.length === 0 ? (
                    <span className="muted">ausgeglichen</span>
                  ) : (
                    g.myBalance.map((b) => (
                      <div key={b.currency}>
                        <span className="small muted">du </span>
                        <BalanceText amount={b.amount} currency={b.currency} />
                      </div>
                    ))
                  )}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="info-box">
        🤖 <strong>Tipp:</strong> Verbinde SplitApp mit Claude oder ChatGPT und erfasse Ausgaben im Chat, z. B. «Ich habe 84 CHF fürs
        Abendessen mit Anna und Ben bezahlt». <Link href="/connect">So geht's</Link>
      </div>

      {creating && <CreateGroupModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateGroupModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('CHF');
  const [members, setMembers] = useState<string[]>(['']);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { group } = await api<{ group: GroupDetail }>('POST', '/groups', {
        name,
        currency,
        members: members.map((m) => m.trim()).filter(Boolean),
      });
      navigate(`/groups/${group.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Neue Gruppe"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" form="group-form" disabled={busy}>
            Erstellen
          </button>
        </>
      }
    >
      <form id="group-form" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Name der Gruppe
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. WG Langstrasse" required autoFocus />
        </label>
        <label className="field">
          Standardwährung
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} maxLength={3} />
        </label>
        <div className="field">
          <span className="small muted">Mitglieder (du bist automatisch dabei)</span>
          {members.map((m, i) => (
            <div key={i} className="row" style={{ marginTop: 6 }}>
              <input
                value={m}
                placeholder={`Name ${i + 1}`}
                onChange={(e) => {
                  const next = [...members];
                  next[i] = e.target.value;
                  if (i === members.length - 1 && e.target.value) next.push('');
                  setMembers(next);
                }}
              />
            </div>
          ))}
          <p className="small muted" style={{ marginTop: 6 }}>
            Später kannst du einen Einladungslink teilen, damit sich die anderen mit ihrem Konto verknüpfen.
          </p>
        </div>
      </form>
    </Modal>
  );
}
