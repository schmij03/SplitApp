import { CATEGORY_IDS } from '../../shared/categories.js';
import { formatMoney, fromMinor, isValidCurrency, toMinor } from '../../shared/money.js';
import { computeShares, SPLIT_TYPES, SplitError, type SplitType } from '../../shared/split.js';
import type { Row } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { activityStmt, type Ctx } from './context.js';
import { listMembers, requireMembership } from './groups.js';

export type ExpenseKind = 'expense' | 'payment';

export interface Expense {
  id: number;
  groupId: number;
  kind: ExpenseKind;
  description: string;
  /** Betrag in kleinster Einheit */
  amount: number;
  currency: string;
  date: string;
  category: string;
  notes: string | null;
  splitType: SplitType;
  payers: { memberId: number; amount: number }[];
  shares: { memberId: number; amount: number; value: number | null }[];
  createdBy: { id: number; name: string } | null;
  createdVia: string;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
}

/** Eingabe in Hauptwährungseinheiten (z. B. 12.50 CHF). */
export interface ExpenseInput {
  kind?: ExpenseKind;
  description: string;
  amount: number;
  currency?: string;
  date?: string;
  category?: string;
  notes?: string | null;
  /** Wer hat bezahlt. Bei nur einer Person darf amount fehlen. */
  payers: { memberId: number; amount?: number | null }[];
  splitType: SplitType;
  /** Für exact: Betrag in Hauptwährungseinheiten; percent: Prozent; shares: Gewicht; equal: ignoriert. */
  split: { memberId: number; value?: number | null }[];
}

export type ExpenseUpdate = Partial<ExpenseInput>;

export interface ListExpensesOptions {
  query?: string;
  memberId?: number;
  fromDate?: string;
  toDate?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function validDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
}

// --- Lesen ----------------------------------------------------------------

async function hydrate(ctx: Ctx, rows: Row[]): Promise<Expense[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const [p, sh] = await ctx.db.batch([
    ctx.db.stmt(`SELECT expense_id, member_id, amount FROM expense_payers WHERE expense_id IN (${ph}) ORDER BY member_id`, ...ids),
    ctx.db.stmt(`SELECT expense_id, member_id, amount, value FROM expense_shares WHERE expense_id IN (${ph}) ORDER BY member_id`, ...ids),
  ]);
  const payers = p!.results as Row[];
  const shares = sh!.results as Row[];
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    kind: r.kind,
    description: r.description,
    amount: r.amount,
    currency: r.currency,
    date: r.date,
    category: r.category,
    notes: r.notes ?? null,
    splitType: r.split_type,
    payers: payers.filter((p) => p.expense_id === r.id).map((p) => ({ memberId: p.member_id, amount: p.amount })),
    shares: shares
      .filter((s) => s.expense_id === r.id)
      .map((s) => ({ memberId: s.member_id, amount: s.amount, value: s.value ?? null })),
    createdBy: r.created_by ? { id: r.created_by, name: r.creator_name } : null,
    createdVia: r.created_via,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    deletedAt: r.deleted_at ?? null,
  }));
}

const SELECT_EXPENSE = `SELECT e.*, u.name AS creator_name FROM expenses e LEFT JOIN users u ON u.id = e.created_by`;

export async function listExpenses(ctx: Ctx, groupId: number, opts: ListExpensesOptions = {}) {
  await requireMembership(ctx, groupId);
  const where = ['e.group_id = ?'];
  const params: (string | number)[] = [groupId];
  if (opts.onlyDeleted) where.push('e.deleted_at IS NOT NULL');
  else if (!opts.includeDeleted) where.push('e.deleted_at IS NULL');
  if (opts.query?.trim()) {
    where.push('(e.description LIKE ? OR e.notes LIKE ?)');
    const like = `%${opts.query.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (opts.fromDate) {
    if (!validDate(opts.fromDate)) throw badRequest('from_date muss im Format YYYY-MM-DD sein.');
    where.push('e.date >= ?');
    params.push(opts.fromDate);
  }
  if (opts.toDate) {
    if (!validDate(opts.toDate)) throw badRequest('to_date muss im Format YYYY-MM-DD sein.');
    where.push('e.date <= ?');
    params.push(opts.toDate);
  }
  if (opts.memberId) {
    where.push(
      `(EXISTS (SELECT 1 FROM expense_payers p WHERE p.expense_id = e.id AND p.member_id = ?)
        OR EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = ?))`,
    );
    params.push(opts.memberId, opts.memberId);
  }
  const whereSql = where.join(' AND ').replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'");
  const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(opts.limit!, 1), 500) : 50;
  const offset = Number.isFinite(opts.offset) ? Math.max(opts.offset!, 0) : 0;
  const [count, list] = await ctx.db.batch([
    ctx.db.stmt(`SELECT COUNT(*) AS n FROM expenses e WHERE ${whereSql}`, ...params),
    ctx.db.stmt(`${SELECT_EXPENSE} WHERE ${whereSql} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset),
  ]);
  const total = (count!.results[0] as Row).n as number;
  return { total, limit, offset, expenses: await hydrate(ctx, list!.results as Row[]) };
}

export async function getExpense(ctx: Ctx, expenseId: number): Promise<Expense> {
  const row = await ctx.db.first<Row>(`${SELECT_EXPENSE} WHERE e.id = ?`, expenseId);
  if (!row) throw notFound('Ausgabe nicht gefunden.');
  await requireMembership(ctx, row.group_id);
  return (await hydrate(ctx, [row]))[0]!;
}

/** Durchsucht alle Gruppen des Benutzers. */
export async function searchExpenses(ctx: Ctx, query: string, limit = 20): Promise<Expense[]> {
  const like = `%${query.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const rows = await ctx.db.all<Row>(
    `${SELECT_EXPENSE}
     JOIN members m ON m.group_id = e.group_id AND m.user_id = ?
     WHERE e.deleted_at IS NULL AND (e.description LIKE ? ESCAPE '\\' OR e.notes LIKE ? ESCAPE '\\')
     ORDER BY e.date DESC, e.id DESC LIMIT ?`,
    ctx.userId,
    like,
    like,
    limit,
  );
  return hydrate(ctx, rows);
}

// --- Schreiben ------------------------------------------------------------

interface Normalized {
  kind: ExpenseKind;
  description: string;
  amount: number;
  currency: string;
  date: string;
  category: string;
  notes: string | null;
  splitType: SplitType;
  payers: { memberId: number; amount: number }[];
  shares: { memberId: number; amount: number; value: number | null }[];
}

async function normalize(ctx: Ctx, groupId: number, input: ExpenseInput): Promise<Normalized> {
  const group = (await ctx.db.first<Row>('SELECT currency FROM groups WHERE id = ?', groupId))!;
  const memberIds = new Set((await listMembers(ctx, groupId)).map((m) => m.id));
  const kind: ExpenseKind = input.kind ?? 'expense';

  const description = String(input.description ?? '').trim();
  if (!description) throw badRequest('Bitte eine Beschreibung angeben.');
  if (description.length > 200) throw badRequest('Die Beschreibung ist zu lang (max. 200 Zeichen).');

  const currency = String(input.currency || group.currency).toUpperCase();
  if (!isValidCurrency(currency)) throw badRequest(`Unbekannte Währung: ${currency}`);

  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) throw badRequest('Ungültiger Betrag.');
  const amount = toMinor(input.amount, currency);
  if (amount <= 0) throw badRequest('Der Betrag muss grösser als 0 sein.');
  if (amount > 1e13) throw badRequest('Der Betrag ist zu gross.');

  const date = input.date || today();
  if (!validDate(date)) throw badRequest('Das Datum muss im Format YYYY-MM-DD sein.');

  const category = kind === 'payment' ? 'payment' : input.category || 'general';
  if (kind === 'expense' && !(CATEGORY_IDS as string[]).includes(category)) {
    throw badRequest(`Unbekannte Kategorie «${category}». Erlaubt: ${CATEGORY_IDS.join(', ')}`);
  }
  const notes = input.notes?.toString().trim() || null;
  if (notes && notes.length > 2000) throw badRequest('Die Notiz ist zu lang (max. 2000 Zeichen).');

  const checkMember = (id: number) => {
    if (!memberIds.has(id)) throw badRequest(`Mitglied ${id} gehört nicht zu dieser Gruppe.`);
  };

  // Zahler
  if (!input.payers?.length) throw badRequest('Bitte angeben, wer bezahlt hat.');
  const payerIds = new Set<number>();
  let payers: { memberId: number; amount: number }[];
  if (input.payers.length === 1 && (input.payers[0]!.amount === undefined || input.payers[0]!.amount === null)) {
    checkMember(input.payers[0]!.memberId);
    payers = [{ memberId: input.payers[0]!.memberId, amount }];
  } else {
    payers = input.payers.map((p) => {
      checkMember(p.memberId);
      if (payerIds.has(p.memberId)) throw badRequest('Eine Person ist mehrfach als Zahler angegeben.');
      payerIds.add(p.memberId);
      if (typeof p.amount !== 'number' || p.amount < 0) throw badRequest('Bei mehreren Zahlern braucht jeder einen Betrag.');
      return { memberId: p.memberId, amount: toMinor(p.amount, currency) };
    });
    payers = payers.filter((p) => p.amount > 0);
    const sum = payers.reduce((a, p) => a + p.amount, 0);
    if (sum !== amount) {
      throw badRequest(
        `Die bezahlten Beträge (${formatMoney(sum, currency)}) entsprechen nicht dem Total (${formatMoney(amount, currency)}).`,
      );
    }
  }

  // Aufteilung
  if (!SPLIT_TYPES.includes(input.splitType)) throw badRequest(`Unbekannte Aufteilungsart: ${input.splitType}`);
  let split = input.split ?? [];
  if (split.length === 0 && input.splitType === 'equal') split = [...memberIds].map((memberId) => ({ memberId }));
  for (const s of split) checkMember(s.memberId);
  let shares;
  try {
    shares = computeShares(
      amount,
      input.splitType,
      split.map((s) => ({
        memberId: s.memberId,
        value:
          input.splitType === 'exact'
            ? toMinor(Number(s.value ?? 0), currency)
            : s.value === undefined || s.value === null
              ? null
              : Number(s.value),
      })),
    );
  } catch (err) {
    if (err instanceof SplitError) throw badRequest(err.message);
    throw err;
  }

  if (kind === 'payment') {
    if (payers.length !== 1 || shares.length !== 1) throw badRequest('Eine Zahlung hat genau einen Sender und einen Empfänger.');
    if (payers[0]!.memberId === shares[0]!.memberId) throw badRequest('Sender und Empfänger müssen verschieden sein.');
  }

  return { kind, description, amount, currency, date, category, notes, splitType: input.splitType, payers, shares };
}

function partStmts(ctx: Ctx, expenseId: number, n: Normalized): D1PreparedStatement[] {
  return [
    ctx.db.stmt('DELETE FROM expense_payers WHERE expense_id = ?', expenseId),
    ctx.db.stmt('DELETE FROM expense_shares WHERE expense_id = ?', expenseId),
    ...n.payers.map((p) =>
      ctx.db.stmt('INSERT INTO expense_payers (expense_id, member_id, amount) VALUES (?, ?, ?)', expenseId, p.memberId, p.amount),
    ),
    ...n.shares.map((sh) =>
      ctx.db.stmt(
        'INSERT INTO expense_shares (expense_id, member_id, amount, value) VALUES (?, ?, ?, ?)',
        expenseId,
        sh.memberId,
        sh.amount,
        sh.value,
      ),
    ),
  ];
}

function label(n: { kind: ExpenseKind; description: string; amount: number; currency: string }) {
  return `«${n.description}» (${formatMoney(n.amount, n.currency)})`;
}

export async function createExpense(ctx: Ctx, groupId: number, input: ExpenseInput): Promise<Expense> {
  await requireMembership(ctx, groupId);
  const n = await normalize(ctx, groupId, input);
  const id = await ctx.db.insertWithId('expenses', (expenseId) => [
    ctx.db.stmt(
      `INSERT INTO expenses (id, group_id, kind, description, amount, currency, date, category, notes, split_type, created_by, created_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      expenseId, groupId, n.kind, n.description, n.amount, n.currency, n.date, n.category, n.notes, n.splitType, ctx.userId, ctx.via,
    ),
    ...partStmts(ctx, expenseId, n),
    activityStmt(
      ctx,
      groupId,
      n.kind === 'payment' ? 'payment.create' : 'expense.create',
      n.kind === 'payment' ? `hat eine Zahlung über ${formatMoney(n.amount, n.currency)} erfasst` : `hat ${label(n)} hinzugefügt`,
      expenseId,
    ),
  ]);
  return getExpense(ctx, id);
}

/** Wandelt eine gespeicherte Ausgabe zurück in eine (bearbeitbare) Eingabe. */
export function toInput(e: Expense): ExpenseInput {
  return {
    kind: e.kind,
    description: e.description,
    amount: fromMinor(e.amount, e.currency),
    currency: e.currency,
    date: e.date,
    category: e.category,
    notes: e.notes,
    payers: e.payers.map((p) => ({ memberId: p.memberId, amount: fromMinor(p.amount, e.currency) })),
    splitType: e.splitType,
    split: e.shares.map((s) => ({
      memberId: s.memberId,
      value: e.splitType === 'exact' ? fromMinor(s.amount, e.currency) : s.value,
    })),
  };
}

export async function updateExpense(ctx: Ctx, expenseId: number, patch: ExpenseUpdate): Promise<Expense> {
  const existing = await getExpense(ctx, expenseId);
  if (existing.deletedAt) throw badRequest('Gelöschte Ausgaben müssen zuerst wiederhergestellt werden.');
  const base = toInput(existing);
  const merged: ExpenseInput = { ...base, kind: existing.kind };
  for (const key of ['description', 'amount', 'currency', 'date', 'category', 'notes', 'splitType'] as const) {
    if (patch[key] !== undefined) (merged as any)[key] = patch[key];
  }
  const amountChanged = patch.amount !== undefined && patch.amount !== base.amount;

  if (patch.payers !== undefined) {
    merged.payers = patch.payers;
  } else if (amountChanged || patch.currency !== undefined) {
    if (base.payers.length === 1) merged.payers = [{ memberId: base.payers[0]!.memberId }];
    else throw badRequest('Diese Ausgabe hat mehrere Zahler. Bitte beim Ändern des Betrags auch «payers» angeben.');
  }

  if (patch.split !== undefined) {
    merged.split = patch.split;
  } else if (patch.splitType !== undefined && patch.splitType !== base.splitType) {
    if (patch.splitType === 'equal') merged.split = base.split.map((s) => ({ memberId: s.memberId }));
    else throw badRequest('Beim Wechsel der Aufteilungsart bitte auch «split» mit den Werten angeben.');
  } else if ((amountChanged || patch.currency !== undefined) && merged.splitType === 'exact') {
    if (base.split.length === 1) merged.split = [{ memberId: base.split[0]!.memberId, value: merged.amount }];
    else throw badRequest('Bei exakter Aufteilung bitte beim Ändern des Betrags auch «split» mit den neuen Beträgen angeben.');
  }

  const n = await normalize(ctx, existing.groupId, merged);
  await ctx.db.batch([
    ctx.db.stmt(
      `UPDATE expenses SET description = ?, amount = ?, currency = ?, date = ?, category = ?, notes = ?, split_type = ?,
       updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      n.description, n.amount, n.currency, n.date, n.category, n.notes, n.splitType, ctx.userId, expenseId,
    ),
    ...partStmts(ctx, expenseId, n),
    activityStmt(ctx, existing.groupId, existing.kind === 'payment' ? 'payment.update' : 'expense.update', `hat ${label(n)} bearbeitet`, expenseId),
  ]);
  return getExpense(ctx, expenseId);
}

/** Löscht eine Ausgabe (weich, kann mit restoreExpense rückgängig gemacht werden). */
export async function deleteExpense(ctx: Ctx, expenseId: number): Promise<Expense> {
  const e = await getExpense(ctx, expenseId);
  if (e.deletedAt) return e;
  await ctx.db.batch([
    ctx.db.stmt(`UPDATE expenses SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`, ctx.userId, expenseId),
    activityStmt(ctx, e.groupId, e.kind === 'payment' ? 'payment.delete' : 'expense.delete', `hat ${label(e)} gelöscht`, expenseId),
  ]);
  return getExpense(ctx, expenseId);
}

export async function restoreExpense(ctx: Ctx, expenseId: number): Promise<Expense> {
  const e = await getExpense(ctx, expenseId);
  if (!e.deletedAt) return e;
  await ctx.db.batch([
    ctx.db.stmt('UPDATE expenses SET deleted_at = NULL, deleted_by = NULL WHERE id = ?', expenseId),
    activityStmt(ctx, e.groupId, 'expense.restore', `hat ${label(e)} wiederhergestellt`, expenseId),
  ]);
  return getExpense(ctx, expenseId);
}

export async function recordPayment(
  ctx: Ctx,
  groupId: number,
  input: { fromMemberId: number; toMemberId: number; amount: number; currency?: string; date?: string; notes?: string | null },
): Promise<Expense> {
  return createExpense(ctx, groupId, {
    kind: 'payment',
    description: 'Zahlung',
    amount: input.amount,
    currency: input.currency,
    date: input.date,
    notes: input.notes,
    payers: [{ memberId: input.fromMemberId }],
    splitType: 'exact',
    split: [{ memberId: input.toMemberId, value: input.amount }],
  });
}
