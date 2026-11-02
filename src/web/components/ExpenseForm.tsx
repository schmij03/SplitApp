import { useMemo, useState, type FormEvent } from 'react';
import { CATEGORIES } from '../../shared/categories.js';
import { fromMinor, parseAmountInput, toMinor } from '../../shared/money.js';
import { computeShares, type SplitEntry } from '../../shared/split.js';
import { api, type Expense, type ExpenseInput, type GroupDetail, type SplitType } from '../api.js';
import { ErrorBox, Modal, money, useToast } from './ui.js';

const SPLIT_LABELS: Record<SplitType, string> = {
  equal: 'Gleich',
  exact: 'Beträge',
  percent: 'Prozent',
  shares: 'Anteile',
};

const today = () => new Date().toISOString().slice(0, 10);
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

interface Props {
  group: GroupDetail;
  expense?: Expense;
  onClose: () => void;
  onSaved: () => void;
}

export function ExpenseForm({ group, expense, onClose, onSaved }: Props) {
  const toast = useToast();
  const members = group.members;
  const [description, setDescription] = useState(expense?.description ?? '');
  const [amountStr, setAmountStr] = useState(expense ? str(fromMinor(expense.amount, expense.currency)) : '');
  const [currency, setCurrency] = useState(expense?.currency ?? group.currency);
  const [date, setDate] = useState(expense?.date ?? today());
  const [category, setCategory] = useState(expense?.category ?? 'general');
  const [notes, setNotes] = useState(expense?.notes ?? '');
  const [multiPayer, setMultiPayer] = useState((expense?.payers.length ?? 1) > 1);
  const [payerId, setPayerId] = useState(expense?.payers[0]?.memberId ?? group.myMemberId);
  const [payerAmounts, setPayerAmounts] = useState<Record<number, string>>(() =>
    Object.fromEntries(expense?.payers.map((p) => [p.memberId, str(fromMinor(p.amount, expense.currency))]) ?? []),
  );
  const [splitType, setSplitType] = useState<SplitType>(expense?.splitType ?? 'equal');
  const [included, setIncluded] = useState<Set<number>>(
    () => new Set(expense ? expense.shares.map((s) => s.memberId) : members.map((m) => m.id)),
  );
  const [values, setValues] = useState<Record<number, string>>(() => {
    if (!expense || expense.splitType === 'equal') return {};
    return Object.fromEntries(
      expense.shares.map((s) => [
        s.memberId,
        expense.splitType === 'exact' ? str(fromMinor(s.amount, expense.currency)) : str(s.value),
      ]),
    );
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(Boolean(expense?.notes));

  const amount = parseAmountInput(amountStr);

  // Live-Vorschau der Aufteilung
  const preview = useMemo(() => {
    if (!amount || amount <= 0) return { shares: new Map<number, number>(), error: null as string | null, remaining: null };
    const total = toMinor(amount, currency);
    const entries: SplitEntry[] =
      splitType === 'equal'
        ? members.filter((m) => included.has(m.id)).map((m) => ({ memberId: m.id }))
        : members
            .map((m) => {
              const v = parseAmountInput(values[m.id] ?? '');
              return { memberId: m.id, value: v === null ? 0 : splitType === 'exact' ? toMinor(v, currency) : v };
            })
            .filter((e) => (e.value ?? 0) > 0);
    let remaining: string | null = null;
    if (splitType === 'exact') {
      const sum = entries.reduce((a, e) => a + (e.value ?? 0), 0);
      if (sum !== total) remaining = `${sum < total ? 'Noch' : 'Zu viel:'} ${money(Math.abs(total - sum), currency)} ${sum < total ? 'zu verteilen' : ''}`;
    }
    if (splitType === 'percent') {
      const sum = entries.reduce((a, e) => a + (e.value ?? 0), 0);
      if (Math.abs(sum - 100) > 0.01) remaining = `Summe ${Math.round(sum * 100) / 100} % (muss 100 % sein)`;
    }
    try {
      const shares = computeShares(total, splitType, entries);
      return { shares: new Map(shares.map((s) => [s.memberId, s.amount])), error: null, remaining };
    } catch (e) {
      return { shares: new Map<number, number>(), error: (e as Error).message, remaining };
    }
  }, [amount, currency, splitType, included, values, members]);

  const payerSum = multiPayer
    ? members.reduce((a, m) => a + toMinor(parseAmountInput(payerAmounts[m.id] ?? '') ?? 0, currency), 0)
    : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!amount || amount <= 0) return setError(new Error('Bitte einen gültigen Betrag eingeben.'));
    const input: ExpenseInput = {
      description,
      amount,
      currency,
      date,
      category,
      notes: notes.trim() || null,
      payers: multiPayer
        ? members
            .map((m) => ({ memberId: m.id, amount: parseAmountInput(payerAmounts[m.id] ?? '') ?? 0 }))
            .filter((p) => p.amount > 0)
        : [{ memberId: payerId }],
      splitType,
      split:
        splitType === 'equal'
          ? members.filter((m) => included.has(m.id)).map((m) => ({ memberId: m.id }))
          : members
              .map((m) => ({ memberId: m.id, value: parseAmountInput(values[m.id] ?? '') ?? 0 }))
              .filter((s) => (s.value ?? 0) > 0),
    };
    setBusy(true);
    try {
      if (expense) await api('PATCH', `/expenses/${expense.id}`, input);
      else await api('POST', `/groups/${group.id}/expenses`, input);
      toast({ message: expense ? 'Ausgabe gespeichert' : 'Ausgabe hinzugefügt' });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!expense) return;
    setBusy(true);
    try {
      await api('DELETE', `/expenses/${expense.id}`);
      toast({
        message: `«${expense.description}» gelöscht`,
        action: {
          label: 'Rückgängig',
          run: () => void api('POST', `/expenses/${expense.id}/restore`).then(onSaved),
        },
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const toggle = (id: number) =>
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      title={expense ? 'Ausgabe bearbeiten' : 'Neue Ausgabe'}
      onClose={onClose}
      footer={
        <>
          {expense && (
            <button type="button" className="danger" onClick={remove} disabled={busy}>
              Löschen
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" form="expense-form" className="primary" disabled={busy}>
            {busy ? 'Speichern…' : 'Speichern'}
          </button>
        </>
      }
    >
      <form id="expense-form" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="row">
          <select
            aria-label="Kategorie"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{ width: 64, fontSize: 22, padding: '6px 4px', textAlign: 'center' }}
            title={CATEGORIES.find((c) => c.id === category)?.label}
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Beschreibung"
            placeholder="Beschreibung, z. B. Abendessen"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            maxLength={200}
            autoFocus={!expense}
          />
        </div>
        <div className="row">
          <input
            aria-label="Betrag"
            className="amount-input"
            inputMode="decimal"
            placeholder="0.00"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            required
          />
          <input
            aria-label="Währung"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            style={{ width: 80, textAlign: 'center' }}
            maxLength={3}
          />
        </div>
        <div className="grid-2">
          <label className="field">
            Bezahlt von
            {multiPayer ? (
              <span className="small">mehrere Personen (siehe unten)</span>
            ) : (
              <select value={payerId} onChange={(e) => setPayerId(Number(e.target.value))}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.isMe ? `${m.name} (du)` : m.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="field">
            Datum
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
        </div>
        <label className="row small muted" style={{ gap: 8 }}>
          <input type="checkbox" checked={multiPayer} onChange={(e) => setMultiPayer(e.target.checked)} />
          Mehrere Personen haben bezahlt
        </label>
        {multiPayer && (
          <div className="card" style={{ padding: 12 }}>
            {members.map((m) => (
              <div key={m.id} className="split-row compact">
                <span />
                <span>{m.name}</span>
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label={`${m.name} hat bezahlt`}
                  value={payerAmounts[m.id] ?? ''}
                  onChange={(e) => setPayerAmounts({ ...payerAmounts, [m.id]: e.target.value })}
                />
              </div>
            ))}
            {amount && payerSum !== toMinor(amount, currency) && (
              <p className="small negative" style={{ marginTop: 6 }}>
                Bezahlt: {money(payerSum ?? 0, currency)} von {money(toMinor(amount, currency), currency)}
              </p>
            )}
          </div>
        )}

        <div className="stack" style={{ gap: 8 }}>
          <span className="small muted">Aufteilen</span>
          <div className="segmented" role="tablist">
            {(Object.keys(SPLIT_LABELS) as SplitType[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={splitType === t}
                className={splitType === t ? 'active' : ''}
                onClick={() => setSplitType(t)}
              >
                {SPLIT_LABELS[t]}
              </button>
            ))}
          </div>
          <div>
            {members.map((m) => (
              <div key={m.id} className={`split-row ${splitType === 'equal' ? 'compact' : ''}`}>
                {splitType === 'equal' ? (
                  <input type="checkbox" checked={included.has(m.id)} onChange={() => toggle(m.id)} aria-label={m.name} />
                ) : (
                  <span />
                )}
                <span onClick={() => splitType === 'equal' && toggle(m.id)} style={{ cursor: splitType === 'equal' ? 'pointer' : undefined }}>
                  {m.name}
                  {m.isMe && <span className="muted small"> (du)</span>}
                </span>
                {splitType !== 'equal' && (
                  <input
                    inputMode="decimal"
                    aria-label={`${SPLIT_LABELS[splitType]} für ${m.name}`}
                    placeholder={splitType === 'exact' ? '0.00' : splitType === 'percent' ? '%' : '0'}
                    value={values[m.id] ?? ''}
                    onChange={(e) => setValues({ ...values, [m.id]: e.target.value })}
                  />
                )}
                <span className="computed">{preview.shares.has(m.id) ? money(preview.shares.get(m.id)!, currency) : '–'}</span>
              </div>
            ))}
          </div>
          {preview.remaining && <p className="small negative">{preview.remaining}</p>}
          {!preview.remaining && preview.error && amount ? <p className="small negative">{preview.error}</p> : null}
        </div>

        {showDetails ? (
          <label className="field">
            Notiz
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </label>
        ) : (
          <button type="button" className="ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowDetails(true)}>
            + Notiz hinzufügen
          </button>
        )}
        {expense && (
          <p className="small muted">
            Erfasst von {expense.createdBy?.name ?? 'Unbekannt'}
            {expense.createdVia !== 'web' && ` (${expense.createdVia.replace('mcp:', 'via ')})`} am{' '}
            {new Date(expense.createdAt).toLocaleString('de-CH')}
            {expense.updatedAt && `, zuletzt geändert ${new Date(expense.updatedAt).toLocaleString('de-CH')}`}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function PaymentForm({
  group,
  payment,
  preset,
  onClose,
  onSaved,
}: {
  group: GroupDetail;
  payment?: Expense;
  preset?: { from: number; to: number; amount: number; currency: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const members = group.members;
  const other = members.find((m) => !m.isMe)?.id ?? members[0]!.id;
  const [from, setFrom] = useState(payment?.payers[0]?.memberId ?? preset?.from ?? group.myMemberId);
  const [to, setTo] = useState(payment?.shares[0]?.memberId ?? preset?.to ?? other);
  const cur0 = payment?.currency ?? preset?.currency ?? group.currency;
  const [currency, setCurrency] = useState(cur0);
  const [amountStr, setAmountStr] = useState(
    payment ? str(fromMinor(payment.amount, cur0)) : preset ? str(fromMinor(preset.amount, cur0)) : '',
  );
  const [date, setDate] = useState(payment?.date ?? today());
  const [notes, setNotes] = useState(payment?.notes ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amount = parseAmountInput(amountStr);
    if (!amount || amount <= 0) return setError(new Error('Bitte einen gültigen Betrag eingeben.'));
    setBusy(true);
    setError(null);
    try {
      if (payment) {
        await api('PATCH', `/expenses/${payment.id}`, {
          amount,
          currency,
          date,
          notes: notes.trim() || null,
          payers: [{ memberId: from }],
          splitType: 'exact',
          split: [{ memberId: to, value: amount }],
        });
      } else {
        await api('POST', `/groups/${group.id}/payments`, { fromMemberId: from, toMemberId: to, amount, currency, date, notes });
      }
      toast({ message: 'Zahlung gespeichert' });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!payment) return;
    setBusy(true);
    await api('DELETE', `/expenses/${payment.id}`).catch(setError);
    toast({
      message: 'Zahlung gelöscht',
      action: { label: 'Rückgängig', run: () => void api('POST', `/expenses/${payment.id}/restore`).then(onSaved) },
    });
    onSaved();
  }

  return (
    <Modal
      title={payment ? 'Zahlung bearbeiten' : 'Ausgleichszahlung erfassen'}
      onClose={onClose}
      footer={
        <>
          {payment && (
            <button type="button" className="danger" onClick={remove} disabled={busy}>
              Löschen
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" form="payment-form" className="primary" disabled={busy}>
            Speichern
          </button>
        </>
      }
    >
      <form id="payment-form" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="grid-2">
          <label className="field">
            Wer hat bezahlt?
            <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.isMe ? `${m.name} (du)` : m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            An wen?
            <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.isMe ? `${m.name} (du)` : m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <input
            aria-label="Betrag"
            className="amount-input"
            inputMode="decimal"
            placeholder="0.00"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            required
            autoFocus
          />
          <input
            aria-label="Währung"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            style={{ width: 80, textAlign: 'center' }}
          />
        </div>
        <label className="field">
          Datum
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="field">
          Notiz (optional)
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="z. B. per TWINT" />
        </label>
      </form>
    </Modal>
  );
}
