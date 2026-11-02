import { useEffect, useState } from 'react';
import { categoryInfo } from '../../shared/categories.js';
import { api, type Activity, type Expense, type GroupDetail, type Transfer } from '../api.js';
import { ExpenseForm, PaymentForm } from '../components/ExpenseForm.js';
import {
  Avatar,
  BalanceText,
  CopyButton,
  ErrorBox,
  formatDate,
  formatDateTime,
  money,
  useLoader,
  useToast,
  viaLabel,
} from '../components/ui.js';
import { absoluteUrl, Link, navigate, useLocation } from '../router.js';

type Tab = 'expenses' | 'balances' | 'activity' | 'settings';

export function GroupPage({ id }: { id: number }) {
  const { query } = useLocation();
  const group = useLoader(() => api<{ group: GroupDetail }>('GET', `/groups/${id}`).then((r) => r.group), [id]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [search, setSearch] = useState('');
  const expenses = useLoader(
    () =>
      api<{ expenses: Expense[]; total: number }>(
        'GET',
        `/groups/${id}/expenses?limit=500${showDeleted ? '&deleted=include' : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`,
      ),
    [id, showDeleted, search],
  );
  const [tab, setTab] = useState<Tab>('expenses');
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  const [paying, setPaying] = useState<{ preset?: Transfer; payment?: Expense } | null>(null);

  const reload = () => {
    group.reload();
    expenses.reload();
  };

  // Deep-Link ?expense=123 (z. B. aus Claude/ChatGPT)
  const deepLink = query.get('expense');
  useEffect(() => {
    if (!deepLink) return;
    api<{ expense: Expense }>('GET', `/expenses/${deepLink}`)
      .then(({ expense }) => (expense.kind === 'payment' ? setPaying({ payment: expense }) : setEditing(expense)))
      .catch(() => {});
  }, [deepLink]);

  const closeModals = () => {
    setEditing(null);
    setPaying(null);
    if (deepLink) navigate(`/groups/${id}`, true);
  };
  const saved = () => {
    closeModals();
    reload();
  };

  if (group.error) {
    return (
      <div className="stack">
        <ErrorBox error={group.error} />
        <Link href="/">← Zurück zur Übersicht</Link>
      </div>
    );
  }
  const g = group.data;
  if (!g) return <div className="empty">Laden…</div>;

  const myBalances = g.balances.filter((b) => b.memberId === g.myMemberId && b.amount !== 0);

  return (
    <div className="stack">
      <div>
        <Link href="/" className="small">
          ← Alle Gruppen
        </Link>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <div>
            <h1>{g.name}</h1>
            <p className="muted small">
              {g.members.map((m) => m.name).join(', ')}
            </p>
          </div>
          <span className="spacer" />
          <div className="row">
            <button onClick={() => setPaying({})}>Ausgleichen</button>
            <button className="primary" onClick={() => setEditing('new')}>
              + Ausgabe
            </button>
          </div>
        </div>
      </div>

      <div className="summary">
        <div className="stat">
          <div className="label">Dein Saldo</div>
          <div className="value">
            {myBalances.length === 0 ? (
              <span className="muted">ausgeglichen</span>
            ) : (
              myBalances.map((b) => (
                <div key={b.currency} className={b.amount > 0 ? 'positive' : 'negative'}>
                  {b.amount > 0 ? '+' : '−'}
                  {money(Math.abs(b.amount), b.currency)}
                </div>
              ))
            )}
          </div>
        </div>
        <div className="stat">
          <div className="label">Gesamtausgaben</div>
          <div className="value">
            {g.totals.length === 0 ? money(0, g.currency) : g.totals.map((t) => <div key={t.currency}>{money(t.amount, t.currency)}</div>)}
          </div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(
          [
            ['expenses', 'Ausgaben'],
            ['balances', 'Salden'],
            ['activity', 'Aktivität'],
            ['settings', 'Einstellungen'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'expenses' && (
        <>
          <div className="row">
            <input type="search" placeholder="Suchen…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <label className="row small muted" style={{ gap: 6, whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
              Gelöschte
            </label>
          </div>
          <ExpenseList
            group={g}
            expenses={expenses.data?.expenses ?? []}
            loading={expenses.loading && !expenses.data}
            onOpen={(e) => (e.kind === 'payment' ? setPaying({ payment: e }) : setEditing(e))}
            onChanged={reload}
          />
        </>
      )}
      {tab === 'balances' && <Balances group={g} onSettle={(t) => setPaying({ preset: t })} />}
      {tab === 'activity' && <ActivityList groupId={g.id} />}
      {tab === 'settings' && <GroupSettings group={g} onChanged={reload} />}

      {editing && (
        <ExpenseForm group={g} expense={editing === 'new' ? undefined : editing} onClose={closeModals} onSaved={saved} />
      )}
      {paying && <PaymentForm group={g} payment={paying.payment} preset={paying.preset} onClose={closeModals} onSaved={saved} />}
    </div>
  );
}

function ExpenseList({
  group,
  expenses,
  loading,
  onOpen,
  onChanged,
}: {
  group: GroupDetail;
  expenses: Expense[];
  loading: boolean;
  onOpen: (e: Expense) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const name = (id: number) => group.members.find((m) => m.id === id)?.name ?? '?';
  if (loading) return <div className="empty">Laden…</div>;
  if (expenses.length === 0)
    return (
      <div className="card empty">
        <div className="big">🧾</div>
        <p>Noch keine Ausgaben. Füge die erste hinzu!</p>
      </div>
    );

  const months = new Map<string, Expense[]>();
  for (const e of expenses) {
    const key = e.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key)!.push(e);
  }

  return (
    <div className="card flush">
      {[...months].map(([month, items]) => (
        <div key={month}>
          <div className="month-header">{formatDate(`${month}-01`, { month: 'long', year: 'numeric' })}</div>
          {items.map((e) => {
            const paid = e.payers.find((p) => p.memberId === group.myMemberId)?.amount ?? 0;
            const owed = e.shares.find((s) => s.memberId === group.myMemberId)?.amount ?? 0;
            const net = paid - owed;
            const deleted = Boolean(e.deletedAt);
            const via = viaLabel(e.createdVia);
            const isPayment = e.kind === 'payment';
            return (
              <button key={e.id} className={`list-item ${deleted ? 'deleted' : ''}`} onClick={() => !deleted && onOpen(e)}>
                <span className="date-badge">
                  {formatDate(e.date, { month: 'short' })}
                  <strong>{Number(e.date.slice(8))}</strong>
                </span>
                <span className="icon-badge">{isPayment ? '💸' : categoryInfo(e.category).icon}</span>
                <span className="grow">
                  <div className="title">
                    {isPayment ? `${name(e.payers[0]!.memberId)} → ${name(e.shares[0]!.memberId)}` : e.description}
                  </div>
                  <div className="small muted">
                    {isPayment
                      ? `Zahlung ${money(e.amount, e.currency)}`
                      : e.payers.length > 1
                        ? `${e.payers.length} Personen haben ${money(e.amount, e.currency)} bezahlt`
                        : `${name(e.payers[0]!.memberId)} hat ${money(e.amount, e.currency)} bezahlt`}
                    {via && <span className="pill accent" style={{ marginLeft: 6 }}>{via}</span>}
                  </div>
                </span>
                <span className="right">
                  {deleted ? (
                    <span
                      role="button"
                      tabIndex={0}
                      className="btn small"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void api('POST', `/expenses/${e.id}/restore`).then(() => {
                          toast({ message: 'Wiederhergestellt' });
                          onChanged();
                        });
                      }}
                    >
                      Wiederherstellen
                    </span>
                  ) : isPayment ? (
                    <span className="muted small">{net === 0 ? 'nicht beteiligt' : net > 0 ? 'du hast bezahlt' : 'du hast erhalten'}</span>
                  ) : net === 0 && paid === 0 ? (
                    <span className="muted small">nicht beteiligt</span>
                  ) : (
                    <>
                      <div className="small muted">{net >= 0 ? 'du bekommst' : 'du schuldest'}</div>
                      <div className={net >= 0 ? 'positive' : 'negative'} style={{ fontWeight: 600 }}>
                        {money(Math.abs(net), e.currency)}
                      </div>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Balances({ group, onSettle }: { group: GroupDetail; onSettle: (t: Transfer) => void }) {
  const name = (id: number) => group.members.find((m) => m.id === id)?.name ?? '?';
  const currencies = [...new Set(group.balances.map((b) => b.currency))];
  if (currencies.length === 0) return <div className="card empty">Noch keine Salden, alles ausgeglichen.</div>;

  return (
    <div className="stack">
      {currencies.map((currency) => {
        const rows = group.balances.filter((b) => b.currency === currency);
        const max = Math.max(1, ...rows.map((r) => Math.abs(r.amount)));
        return (
          <div key={currency} className="card">
            <div className="card-title">
              <h2>Salden {currency}</h2>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              {rows.map((b) => {
                const m = group.members.find((x) => x.id === b.memberId)!;
                return (
                  <div key={b.memberId} className="row">
                    <Avatar name={m.name} id={m.id} />
                    <div className="grow" style={{ flex: 1, minWidth: 0 }}>
                      <div className="row">
                        <strong>{m.isMe ? `${m.name} (du)` : m.name}</strong>
                        <span className="spacer" />
                        <BalanceText amount={b.amount} currency={currency} subject={m.isMe ? 'du' : 'er'} />
                      </div>
                      <div className="bar-row">
                        <div>{b.amount < 0 && <div className="bar neg" style={{ width: `${(-b.amount / max) * 100}%` }} />}</div>
                        <div>{b.amount > 0 && <div className="bar pos" style={{ width: `${(b.amount / max) * 100}%` }} />}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="card flush">
        <div style={{ padding: '16px 20px 8px' }}>
          <h2>Vorschlag zum Ausgleichen</h2>
          <p className="small muted">Mit möglichst wenigen Zahlungen ist alles ausgeglichen.</p>
        </div>
        {group.debts.length === 0 ? (
          <div className="empty">🎉 Alles ausgeglichen!</div>
        ) : (
          <div className="list">
            {group.debts.map((d, i) => (
              <div key={i} className="list-item">
                <Avatar name={name(d.from)} id={d.from} />
                <span className="grow">
                  <strong>{d.from === group.myMemberId ? 'Du' : name(d.from)}</strong>{' '}
                  {d.from === group.myMemberId ? 'schuldest' : 'schuldet'}{' '}
                  <strong>{d.to === group.myMemberId ? 'dir' : name(d.to)}</strong>
                  <div className="negative" style={{ fontWeight: 600 }}>
                    {money(d.amount, d.currency)}
                  </div>
                </span>
                <button className="small" onClick={() => onSettle(d)}>
                  Als bezahlt erfassen
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityList({ groupId }: { groupId: number }) {
  const { data, error } = useLoader(() => api<{ activity: Activity[] }>('GET', `/groups/${groupId}/activity?limit=100`), [groupId]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Laden…</div>;
  return (
    <div className="card flush">
      <div className="list">
        {data.activity.map((a) => (
          <div key={a.id} className="list-item">
            <Avatar name={a.user?.name ?? '?'} id={a.user?.id ?? 0} />
            <span className="grow">
              <div>
                <strong>{a.user?.name ?? 'Jemand'}</strong> {a.summary}
              </div>
              <div className="small muted">
                {formatDateTime(a.createdAt)}
                {viaLabel(a.via) && <span className="pill accent" style={{ marginLeft: 6 }}>{viaLabel(a.via)}</span>}
              </div>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupSettings({ group, onChanged }: { group: GroupDetail; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(group.name);
  const [currency, setCurrency] = useState(group.currency);
  const [newMember, setNewMember] = useState('');
  const [error, setError] = useState<unknown>(null);
  const inviteUrl = absoluteUrl(`/join/${group.inviteToken}`);

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setError(null);
    try {
      await fn();
      if (message) toast({ message });
      onChanged();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <div className="card stack">
        <h2>Einladen</h2>
        <p className="small muted">
          Wer diesen Link öffnet, kann der Gruppe beitreten und sich mit einem bestehenden Platzhalter (z. B. «Anna») verknüpfen.
        </p>
        <div className="code-block">
          <code>{inviteUrl}</code>
          <CopyButton text={inviteUrl} />
        </div>
        <div>
          <button className="small" onClick={() => run(() => api('POST', `/groups/${group.id}/invite`), 'Neuer Link erstellt, der alte ist ungültig.')}>
            Neuen Link erzeugen
          </button>
        </div>
      </div>

      <div className="card stack">
        <h2>Mitglieder</h2>
        <div className="list">
          {group.members.map((m) => (
            <div key={m.id} className="row" style={{ padding: '6px 0' }}>
              <Avatar name={m.name} id={m.id} />
              <span style={{ flex: 1 }}>
                {m.name} {m.isMe && <span className="muted small">(du)</span>}
                <div className="small muted">{m.userId ? 'mit Konto verknüpft' : 'Platzhalter, noch nicht beigetreten'}</div>
              </span>
              {!m.userId && (
                <>
                  <button
                    className="small ghost"
                    onClick={() => {
                      const n = window.prompt('Neuer Name', m.name);
                      if (n) void run(() => api('PATCH', `/groups/${group.id}/members/${m.id}`, { name: n }));
                    }}
                  >
                    Umbenennen
                  </button>
                  <button
                    className="small ghost danger"
                    onClick={() =>
                      window.confirm(`${m.name} entfernen?`) &&
                      void run(() => api('DELETE', `/groups/${group.id}/members/${m.id}`), `${m.name} entfernt`)
                    }
                  >
                    Entfernen
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api('POST', `/groups/${group.id}/members`, { name: newMember }), `${newMember} hinzugefügt`).then(() =>
              setNewMember(''),
            );
          }}
        >
          <input placeholder="Name des neuen Mitglieds" value={newMember} onChange={(e) => setNewMember(e.target.value)} required />
          <button>Hinzufügen</button>
        </form>
      </div>

      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api('PATCH', `/groups/${group.id}`, { name, currency }), 'Gespeichert');
        }}
      >
        <h2>Gruppe</h2>
        <div className="grid-2">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            Standardwährung
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} maxLength={3} />
          </label>
        </div>
        <div>
          <button className="primary">Speichern</button>
        </div>
      </form>

      <div className="card stack">
        <h2 className="danger-text">Gefahrenzone</h2>
        <div className="row wrap">
          <button
            onClick={() =>
              window.confirm('Gruppe verlassen? Deine bisherigen Ausgaben bleiben erhalten.') &&
              void api('POST', `/groups/${group.id}/leave`).then(() => navigate('/'), setError)
            }
          >
            Gruppe verlassen
          </button>
          <button
            className="danger"
            onClick={() =>
              window.prompt(`Zum endgültigen Löschen den Gruppennamen «${group.name}» eingeben:`) === group.name &&
              void api('DELETE', `/groups/${group.id}`).then(() => navigate('/'), setError)
            }
          >
            Gruppe löschen
          </button>
        </div>
      </div>
    </div>
  );
}
