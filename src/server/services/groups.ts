import { computeBalances, simplifyDebts, type LedgerEntry, type Transfer } from '../../shared/debts.js';
import { isValidCurrency } from '../../shared/money.js';
import { randomToken } from '../crypto.js';
import { tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { logActivity, type Ctx, type Row } from './context.js';
import { getUser } from './users.js';

export interface Member {
  id: number;
  name: string;
  userId: number | null;
  isMe: boolean;
}

export interface BalanceLine {
  currency: string;
  amount: number;
}

export interface GroupSummary {
  id: number;
  name: string;
  currency: string;
  memberCount: number;
  myMemberId: number;
  myBalance: BalanceLine[];
  lastActivityAt: string;
}

export interface GroupDetail {
  id: number;
  name: string;
  currency: string;
  inviteToken: string;
  createdAt: string;
  myMemberId: number;
  members: Member[];
  /** Saldo pro Mitglied und Währung (positiv = bekommt Geld). */
  balances: { memberId: number; currency: string; amount: number }[];
  /** Vorgeschlagene Ausgleichszahlungen (vereinfacht). */
  debts: Transfer[];
  /** Total aller Ausgaben pro Währung (ohne Zahlungen). */
  totals: BalanceLine[];
}

const cleanName = (name: unknown, what = 'Name') => {
  const n = String(name ?? '').trim();
  if (!n) throw badRequest(`${what} darf nicht leer sein.`);
  if (n.length > 80) throw badRequest(`${what} ist zu lang (max. 80 Zeichen).`);
  return n;
};

const cleanCurrency = (currency: unknown) => {
  const c = String(currency ?? 'CHF').trim().toUpperCase();
  if (!isValidCurrency(c)) throw badRequest(`Unbekannte Währung: ${c}`);
  return c;
};

/** Prüft, dass der aktuelle Benutzer Mitglied der Gruppe ist, und gibt seine Mitglieds-ID zurück. */
export function requireMembership(ctx: Ctx, groupId: number): number {
  const group = ctx.db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
  if (!group) throw notFound('Gruppe nicht gefunden.');
  const row = ctx.db.prepare('SELECT id FROM members WHERE group_id = ? AND user_id = ?').get(groupId, ctx.userId) as
    | Row
    | undefined;
  if (!row) throw forbidden('Du bist kein Mitglied dieser Gruppe.');
  return row.id;
}

export function listMembers(ctx: Ctx, groupId: number): Member[] {
  const rows = ctx.db
    .prepare(
      `SELECT m.id, COALESCE(u.name, m.name) AS name, m.user_id
       FROM members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? ORDER BY m.id`,
    )
    .all(groupId) as Row[];
  return rows.map((r) => ({ id: r.id, name: r.name, userId: r.user_id ?? null, isMe: r.user_id === ctx.userId }));
}

/** Alle (nicht gelöschten) Buchungen einer Gruppe als Ledger für die Saldoberechnung. */
export function ledger(ctx: Ctx, groupIds: number[]): Map<number, LedgerEntry[]> {
  const result = new Map<number, LedgerEntry[]>();
  if (groupIds.length === 0) return result;
  const placeholders = groupIds.map(() => '?').join(',');
  const expenses = ctx.db
    .prepare(`SELECT id, group_id, currency FROM expenses WHERE deleted_at IS NULL AND group_id IN (${placeholders})`)
    .all(...groupIds) as Row[];
  const byId = new Map<number, LedgerEntry>();
  for (const e of expenses) {
    const entry: LedgerEntry = { currency: e.currency, payers: [], shares: [] };
    byId.set(e.id, entry);
    if (!result.has(e.group_id)) result.set(e.group_id, []);
    result.get(e.group_id)!.push(entry);
  }
  const payers = ctx.db
    .prepare(
      `SELECT p.expense_id, p.member_id, p.amount FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.deleted_at IS NULL AND e.group_id IN (${placeholders})`,
    )
    .all(...groupIds) as Row[];
  for (const p of payers) byId.get(p.expense_id)?.payers.push({ memberId: p.member_id, amount: p.amount });
  const shares = ctx.db
    .prepare(
      `SELECT s.expense_id, s.member_id, s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.deleted_at IS NULL AND e.group_id IN (${placeholders})`,
    )
    .all(...groupIds) as Row[];
  for (const s of shares) byId.get(s.expense_id)?.shares.push({ memberId: s.member_id, amount: s.amount });
  return result;
}

export function listGroups(ctx: Ctx): GroupSummary[] {
  const rows = ctx.db
    .prepare(
      `SELECT g.id, g.name, g.currency, m.id AS my_member_id,
         (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS member_count,
         COALESCE((SELECT MAX(created_at) FROM activity WHERE group_id = g.id), g.created_at) AS last_activity_at
       FROM groups g JOIN members m ON m.group_id = g.id AND m.user_id = ?
       ORDER BY last_activity_at DESC`,
    )
    .all(ctx.userId) as Row[];
  const ledgers = ledger(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const balances = computeBalances(ledgers.get(r.id) ?? []);
    const myBalance: BalanceLine[] = [];
    for (const [currency, map] of balances) {
      const amount = map.get(r.my_member_id) ?? 0;
      if (amount !== 0) myBalance.push({ currency, amount });
    }
    return {
      id: r.id,
      name: r.name,
      currency: r.currency,
      memberCount: r.member_count,
      myMemberId: r.my_member_id,
      myBalance,
      lastActivityAt: r.last_activity_at,
    };
  });
}

export function getGroup(ctx: Ctx, groupId: number): GroupDetail {
  const myMemberId = requireMembership(ctx, groupId);
  const g = ctx.db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as Row;
  const members = listMembers(ctx, groupId);
  const entries = ledger(ctx, [groupId]).get(groupId) ?? [];
  const balancesByCurrency = computeBalances(entries);

  const balances: GroupDetail['balances'] = [];
  const debts: Transfer[] = [];
  for (const [currency, map] of balancesByCurrency) {
    for (const m of members) balances.push({ memberId: m.id, currency, amount: map.get(m.id) ?? 0 });
    debts.push(...simplifyDebts(map, currency));
  }
  const totalsRows = ctx.db
    .prepare(
      `SELECT currency, SUM(amount) AS total FROM expenses
       WHERE group_id = ? AND deleted_at IS NULL AND kind = 'expense' GROUP BY currency`,
    )
    .all(groupId) as Row[];

  return {
    id: g.id,
    name: g.name,
    currency: g.currency,
    inviteToken: g.invite_token,
    createdAt: g.created_at,
    myMemberId,
    members,
    balances,
    debts,
    totals: totalsRows.map((r) => ({ currency: r.currency, amount: r.total })),
  };
}

export function createGroup(ctx: Ctx, input: { name: string; currency?: string; members?: string[] }): GroupDetail {
  const name = cleanName(input.name, 'Gruppenname');
  const currency = cleanCurrency(input.currency);
  const others = (input.members ?? []).map((m) => cleanName(m, 'Mitgliedsname'));
  const me = getUser(ctx.db, ctx.userId);
  if (!me) throw notFound('Benutzer nicht gefunden.');

  const groupId = tx(ctx.db, () => {
    const res = ctx.db
      .prepare('INSERT INTO groups (name, currency, invite_token, created_by) VALUES (?, ?, ?, ?)')
      .run(name, currency, randomToken(18), ctx.userId);
    const id = Number(res.lastInsertRowid);
    ctx.db.prepare('INSERT INTO members (group_id, user_id, name) VALUES (?, ?, ?)').run(id, ctx.userId, me.name);
    for (const m of others) ctx.db.prepare('INSERT INTO members (group_id, name) VALUES (?, ?)').run(id, m);
    logActivity(ctx, id, 'group.create', `hat die Gruppe «${name}» erstellt`);
    return id;
  });
  return getGroup(ctx, groupId);
}

export function updateGroup(ctx: Ctx, groupId: number, input: { name?: string; currency?: string }): GroupDetail {
  requireMembership(ctx, groupId);
  if (input.name !== undefined) {
    const name = cleanName(input.name, 'Gruppenname');
    ctx.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, groupId);
    logActivity(ctx, groupId, 'group.update', `hat die Gruppe in «${name}» umbenannt`);
  }
  if (input.currency !== undefined) {
    const currency = cleanCurrency(input.currency);
    ctx.db.prepare('UPDATE groups SET currency = ? WHERE id = ?').run(currency, groupId);
    logActivity(ctx, groupId, 'group.update', `hat die Standardwährung auf ${currency} gesetzt`);
  }
  return getGroup(ctx, groupId);
}

export function deleteGroup(ctx: Ctx, groupId: number): void {
  requireMembership(ctx, groupId);
  ctx.db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
}

export function addMember(ctx: Ctx, groupId: number, name: string): Member {
  requireMembership(ctx, groupId);
  const clean = cleanName(name, 'Mitgliedsname');
  const res = ctx.db.prepare('INSERT INTO members (group_id, name) VALUES (?, ?)').run(groupId, clean);
  logActivity(ctx, groupId, 'member.add', `hat ${clean} hinzugefügt`);
  return { id: Number(res.lastInsertRowid), name: clean, userId: null, isMe: false };
}

export function renameMember(ctx: Ctx, groupId: number, memberId: number, name: string): Member {
  requireMembership(ctx, groupId);
  const member = ctx.db.prepare('SELECT * FROM members WHERE id = ? AND group_id = ?').get(memberId, groupId) as
    | Row
    | undefined;
  if (!member) throw notFound('Mitglied nicht gefunden.');
  if (member.user_id) throw badRequest('Verknüpfte Mitglieder ändern ihren Namen selbst im Profil.');
  const clean = cleanName(name, 'Mitgliedsname');
  ctx.db.prepare('UPDATE members SET name = ? WHERE id = ?').run(clean, memberId);
  return { id: memberId, name: clean, userId: null, isMe: false };
}

export function removeMember(ctx: Ctx, groupId: number, memberId: number): void {
  requireMembership(ctx, groupId);
  const member = ctx.db.prepare('SELECT * FROM members WHERE id = ? AND group_id = ?').get(memberId, groupId) as
    | Row
    | undefined;
  if (!member) throw notFound('Mitglied nicht gefunden.');
  if (member.user_id === ctx.userId) throw badRequest('Um selbst auszutreten, «Gruppe verlassen» verwenden.');
  const used =
    ctx.db.prepare('SELECT 1 FROM expense_payers WHERE member_id = ? LIMIT 1').get(memberId) ||
    ctx.db.prepare('SELECT 1 FROM expense_shares WHERE member_id = ? LIMIT 1').get(memberId);
  if (used) throw badRequest('Dieses Mitglied kommt in Ausgaben vor und kann nicht entfernt werden.');
  ctx.db.prepare('DELETE FROM members WHERE id = ?').run(memberId);
  logActivity(ctx, groupId, 'member.remove', `hat ${member.name} entfernt`);
}

/** Benutzer verlässt die Gruppe. Sein Mitglied bleibt (für die Ausgaben) als unverknüpfter Platzhalter erhalten. */
export function leaveGroup(ctx: Ctx, groupId: number): void {
  const memberId = requireMembership(ctx, groupId);
  const me = getUser(ctx.db, ctx.userId)!;
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE members SET user_id = NULL, name = ? WHERE id = ?').run(me.name, memberId);
    logActivity(ctx, groupId, 'member.leave', 'hat die Gruppe verlassen');
    const remaining = ctx.db.prepare('SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND user_id IS NOT NULL').get(
      groupId,
    ) as Row;
    if (remaining.n === 0) ctx.db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
  });
}

export function regenerateInvite(ctx: Ctx, groupId: number): string {
  requireMembership(ctx, groupId);
  const token = randomToken(18);
  ctx.db.prepare('UPDATE groups SET invite_token = ? WHERE id = ?').run(token, groupId);
  return token;
}

// --- Einladungen ----------------------------------------------------------

export function getInvite(ctx: Ctx, token: string) {
  const g = ctx.db.prepare('SELECT id, name, currency FROM groups WHERE invite_token = ?').get(token) as Row | undefined;
  if (!g) throw notFound('Dieser Einladungslink ist ungültig oder abgelaufen.');
  const members = listMembers(ctx, g.id);
  return {
    groupId: g.id,
    name: g.name,
    currency: g.currency,
    alreadyMember: members.some((m) => m.isMe),
    members: members.map((m) => ({ id: m.id, name: m.name, claimed: m.userId !== null })),
  };
}

/** Tritt per Einladungslink bei. Optional wird ein bestehender Platzhalter (z. B. «Anna») übernommen. */
export function joinByInvite(ctx: Ctx, token: string, claimMemberId?: number | null): number {
  const invite = getInvite(ctx, token);
  if (invite.alreadyMember) return invite.groupId;
  const me = getUser(ctx.db, ctx.userId)!;
  tx(ctx.db, () => {
    if (claimMemberId) {
      const m = ctx.db
        .prepare('SELECT id, name, user_id FROM members WHERE id = ? AND group_id = ?')
        .get(claimMemberId, invite.groupId) as Row | undefined;
      if (!m) throw notFound('Mitglied nicht gefunden.');
      if (m.user_id) throw badRequest('Dieses Mitglied ist bereits mit einem Konto verknüpft.');
      ctx.db.prepare('UPDATE members SET user_id = ? WHERE id = ?').run(ctx.userId, m.id);
      logActivity(ctx, invite.groupId, 'member.join', `ist beigetreten (als ${m.name})`);
    } else {
      ctx.db.prepare('INSERT INTO members (group_id, user_id, name) VALUES (?, ?, ?)').run(
        invite.groupId,
        ctx.userId,
        me.name,
      );
      logActivity(ctx, invite.groupId, 'member.join', 'ist der Gruppe beigetreten');
    }
  });
  return invite.groupId;
}

export function listActivity(ctx: Ctx, groupId: number, limit = 50) {
  requireMembership(ctx, groupId);
  const rows = ctx.db
    .prepare(
      `SELECT a.id, a.action, a.summary, a.via, a.expense_id, a.created_at, u.name AS user_name, a.user_id
       FROM activity a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.group_id = ? ORDER BY a.id DESC LIMIT ?`,
    )
    .all(groupId, Math.min(Math.max(limit, 1), 200)) as Row[];
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    summary: r.summary,
    via: r.via,
    expenseId: r.expense_id ?? null,
    createdAt: r.created_at,
    user: r.user_id ? { id: r.user_id, name: r.user_name } : null,
  }));
}
