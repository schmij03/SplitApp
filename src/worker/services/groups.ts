import { computeBalances, simplifyDebts, type LedgerEntry, type Transfer } from '../../shared/debts.js';
import { isValidCurrency } from '../../shared/money.js';
import { randomToken } from '../crypto.js';
import type { Row } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { activityStmt, type Ctx } from './context.js';
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
  const c = String(currency || 'CHF').trim().toUpperCase();
  if (!isValidCurrency(c)) throw badRequest(`Unbekannte Währung: ${c}`);
  return c;
};

/** Prüft, dass der aktuelle Benutzer Mitglied der Gruppe ist, und gibt seine Mitglieds-ID zurück. */
export async function requireMembership(ctx: Ctx, groupId: number): Promise<number> {
  const row = await ctx.db.first<Row>(
    `SELECT g.id AS group_id, m.id AS member_id FROM groups g
     LEFT JOIN members m ON m.group_id = g.id AND m.user_id = ? WHERE g.id = ?`,
    ctx.userId,
    groupId,
  );
  if (!row) throw notFound('Gruppe nicht gefunden.');
  if (!row.member_id) throw forbidden('Du bist kein Mitglied dieser Gruppe.');
  return row.member_id;
}

/** Mitglieder einer Gruppe. Achtung: prüft keine Berechtigung, vorher requireMembership aufrufen. */
export async function listMembers(ctx: Ctx, groupId: number): Promise<Member[]> {
  const rows = await ctx.db.all<Row>(
    `SELECT m.id, COALESCE(u.name, m.name) AS name, m.user_id
     FROM members m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? ORDER BY m.id`,
    groupId,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, userId: r.user_id ?? null, isMe: r.user_id === ctx.userId }));
}

/** Alle (nicht gelöschten) Buchungen der Gruppen als Ledger für die Saldoberechnung. */
async function ledger(ctx: Ctx, groupIds: number[]): Promise<Map<number, LedgerEntry[]>> {
  const result = new Map<number, LedgerEntry[]>();
  if (groupIds.length === 0) return result;
  const ph = groupIds.map(() => '?').join(',');
  const [expenses, payers, shares] = await ctx.db.batch([
    ctx.db.stmt(`SELECT id, group_id, currency FROM expenses WHERE deleted_at IS NULL AND group_id IN (${ph})`, ...groupIds),
    ctx.db.stmt(
      `SELECT p.expense_id, p.member_id, p.amount FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.deleted_at IS NULL AND e.group_id IN (${ph})`,
      ...groupIds,
    ),
    ctx.db.stmt(
      `SELECT s.expense_id, s.member_id, s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.deleted_at IS NULL AND e.group_id IN (${ph})`,
      ...groupIds,
    ),
  ]);
  const byId = new Map<number, LedgerEntry>();
  for (const e of expenses!.results as Row[]) {
    const entry: LedgerEntry = { currency: e.currency, payers: [], shares: [] };
    byId.set(e.id, entry);
    if (!result.has(e.group_id)) result.set(e.group_id, []);
    result.get(e.group_id)!.push(entry);
  }
  for (const p of payers!.results as Row[]) byId.get(p.expense_id)?.payers.push({ memberId: p.member_id, amount: p.amount });
  for (const s of shares!.results as Row[]) byId.get(s.expense_id)?.shares.push({ memberId: s.member_id, amount: s.amount });
  return result;
}

export async function listGroups(ctx: Ctx): Promise<GroupSummary[]> {
  const rows = await ctx.db.all<Row>(
    `SELECT g.id, g.name, g.currency, m.id AS my_member_id,
       (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS member_count,
       COALESCE((SELECT MAX(created_at) FROM activity WHERE group_id = g.id), g.created_at) AS last_activity_at
     FROM groups g JOIN members m ON m.group_id = g.id AND m.user_id = ?
     ORDER BY last_activity_at DESC`,
    ctx.userId,
  );
  const ledgers = await ledger(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const myBalance: BalanceLine[] = [];
    for (const [currency, map] of computeBalances(ledgers.get(r.id) ?? [])) {
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

export async function getGroup(ctx: Ctx, groupId: number): Promise<GroupDetail> {
  const myMemberId = await requireMembership(ctx, groupId);
  const [g, members, ledgers, totals] = await Promise.all([
    ctx.db.first<Row>('SELECT * FROM groups WHERE id = ?', groupId),
    listMembers(ctx, groupId),
    ledger(ctx, [groupId]),
    ctx.db.all<Row>(
      `SELECT currency, SUM(amount) AS total FROM expenses
       WHERE group_id = ? AND deleted_at IS NULL AND kind = 'expense' GROUP BY currency`,
      groupId,
    ),
  ]);
  const balances: GroupDetail['balances'] = [];
  const debts: Transfer[] = [];
  for (const [currency, map] of computeBalances(ledgers.get(groupId) ?? [])) {
    for (const m of members) balances.push({ memberId: m.id, currency, amount: map.get(m.id) ?? 0 });
    debts.push(...simplifyDebts(map, currency));
  }
  return {
    id: g!.id,
    name: g!.name,
    currency: g!.currency,
    inviteToken: g!.invite_token,
    createdAt: g!.created_at,
    myMemberId,
    members,
    balances,
    debts,
    totals: totals.map((r) => ({ currency: r.currency, amount: r.total })),
  };
}

export async function createGroup(ctx: Ctx, input: { name?: string; currency?: string; members?: string[] }): Promise<GroupDetail> {
  const name = cleanName(input.name, 'Gruppenname');
  const currency = cleanCurrency(input.currency);
  const others = (Array.isArray(input.members) ? input.members : []).map((m) => cleanName(m, 'Mitgliedsname'));
  const me = await getUser(ctx.db, ctx.userId);
  if (!me) throw notFound('Benutzer nicht gefunden.');
  const groupId = await ctx.db.insertWithId('groups', (id) => [
    ctx.db.stmt('INSERT INTO groups (id, name, currency, invite_token, created_by) VALUES (?, ?, ?, ?, ?)', id, name, currency, randomToken(18), ctx.userId),
    ctx.db.stmt('INSERT INTO members (group_id, user_id, name) VALUES (?, ?, ?)', id, ctx.userId, me.name),
    ...others.map((m) => ctx.db.stmt('INSERT INTO members (group_id, name) VALUES (?, ?)', id, m)),
    activityStmt(ctx, id, 'group.create', `hat die Gruppe «${name}» erstellt`),
  ]);
  return getGroup(ctx, groupId);
}

export async function updateGroup(ctx: Ctx, groupId: number, input: { name?: string; currency?: string }): Promise<GroupDetail> {
  await requireMembership(ctx, groupId);
  const stmts: D1PreparedStatement[] = [];
  if (input.name !== undefined) {
    const name = cleanName(input.name, 'Gruppenname');
    stmts.push(ctx.db.stmt('UPDATE groups SET name = ? WHERE id = ?', name, groupId));
    stmts.push(activityStmt(ctx, groupId, 'group.update', `hat die Gruppe in «${name}» umbenannt`));
  }
  if (input.currency !== undefined) {
    const currency = cleanCurrency(input.currency);
    stmts.push(ctx.db.stmt('UPDATE groups SET currency = ? WHERE id = ?', currency, groupId));
    stmts.push(activityStmt(ctx, groupId, 'group.update', `hat die Standardwährung auf ${currency} gesetzt`));
  }
  if (stmts.length) await ctx.db.batch(stmts);
  return getGroup(ctx, groupId);
}

export async function deleteGroup(ctx: Ctx, groupId: number): Promise<void> {
  await requireMembership(ctx, groupId);
  await ctx.db.run('DELETE FROM groups WHERE id = ?', groupId);
}

export async function addMember(ctx: Ctx, groupId: number, name: unknown): Promise<Member> {
  await requireMembership(ctx, groupId);
  const clean = cleanName(name, 'Mitgliedsname');
  const [res] = await ctx.db.batch([
    ctx.db.stmt('INSERT INTO members (group_id, name) VALUES (?, ?)', groupId, clean),
    activityStmt(ctx, groupId, 'member.add', `hat ${clean} hinzugefügt`),
  ]);
  return { id: Number(res!.meta.last_row_id), name: clean, userId: null, isMe: false };
}

async function getMemberRow(ctx: Ctx, groupId: number, memberId: number): Promise<Row> {
  const member = await ctx.db.first<Row>('SELECT * FROM members WHERE id = ? AND group_id = ?', memberId, groupId);
  if (!member) throw notFound('Mitglied nicht gefunden.');
  return member;
}

export async function renameMember(ctx: Ctx, groupId: number, memberId: number, name: unknown): Promise<Member> {
  await requireMembership(ctx, groupId);
  const member = await getMemberRow(ctx, groupId, memberId);
  if (member.user_id) throw badRequest('Verknüpfte Mitglieder ändern ihren Namen selbst im Profil.');
  const clean = cleanName(name, 'Mitgliedsname');
  await ctx.db.run('UPDATE members SET name = ? WHERE id = ?', clean, memberId);
  return { id: memberId, name: clean, userId: null, isMe: false };
}

export async function removeMember(ctx: Ctx, groupId: number, memberId: number): Promise<void> {
  await requireMembership(ctx, groupId);
  const member = await getMemberRow(ctx, groupId, memberId);
  if (member.user_id === ctx.userId) throw badRequest('Um selbst auszutreten, «Gruppe verlassen» verwenden.');
  const used = await ctx.db.first(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM expense_payers WHERE member_id = ?) OR EXISTS (SELECT 1 FROM expense_shares WHERE member_id = ?)`,
    memberId,
    memberId,
  );
  if (used) throw badRequest('Dieses Mitglied kommt in Ausgaben vor und kann nicht entfernt werden.');
  await ctx.db.batch([
    ctx.db.stmt('DELETE FROM members WHERE id = ?', memberId),
    activityStmt(ctx, groupId, 'member.remove', `hat ${member.name} entfernt`),
  ]);
}

/** Benutzer verlässt die Gruppe. Sein Mitglied bleibt (für die Ausgaben) als Platzhalter erhalten. */
export async function leaveGroup(ctx: Ctx, groupId: number): Promise<void> {
  const memberId = await requireMembership(ctx, groupId);
  const me = (await getUser(ctx.db, ctx.userId))!;
  await ctx.db.batch([
    ctx.db.stmt('UPDATE members SET user_id = NULL, name = ? WHERE id = ?', me.name, memberId),
    activityStmt(ctx, groupId, 'member.leave', 'hat die Gruppe verlassen'),
    // Ohne verknüpfte Benutzer ist die Gruppe verwaist und wird gelöscht.
    ctx.db.stmt(
      'DELETE FROM groups WHERE id = ? AND NOT EXISTS (SELECT 1 FROM members WHERE group_id = ? AND user_id IS NOT NULL)',
      groupId,
      groupId,
    ),
  ]);
}

export async function regenerateInvite(ctx: Ctx, groupId: number): Promise<string> {
  await requireMembership(ctx, groupId);
  const token = randomToken(18);
  await ctx.db.run('UPDATE groups SET invite_token = ? WHERE id = ?', token, groupId);
  return token;
}

// --- Einladungen ----------------------------------------------------------

export async function getInvite(ctx: Ctx, token: string) {
  const g = await ctx.db.first<Row>('SELECT id, name, currency FROM groups WHERE invite_token = ?', token);
  if (!g) throw notFound('Dieser Einladungslink ist ungültig oder abgelaufen.');
  const members = await listMembers(ctx, g.id);
  return {
    groupId: g.id as number,
    name: g.name as string,
    currency: g.currency as string,
    alreadyMember: members.some((m) => m.isMe),
    members: members.map((m) => ({ id: m.id, name: m.name, claimed: m.userId !== null })),
  };
}

/** Tritt per Einladungslink bei. Optional wird ein bestehender Platzhalter (z. B. «Anna») übernommen. */
export async function joinByInvite(ctx: Ctx, token: string, claimMemberId?: number | null): Promise<number> {
  const invite = await getInvite(ctx, token);
  if (invite.alreadyMember) return invite.groupId;
  if (claimMemberId) {
    const m = invite.members.find((x) => x.id === claimMemberId);
    if (!m) throw notFound('Mitglied nicht gefunden.');
    if (m.claimed) throw badRequest('Dieses Mitglied ist bereits mit einem Konto verknüpft.');
    const [res] = await ctx.db.batch([
      ctx.db.stmt('UPDATE members SET user_id = ? WHERE id = ? AND user_id IS NULL', ctx.userId, m.id),
      activityStmt(ctx, invite.groupId, 'member.join', `ist beigetreten (als ${m.name})`),
    ]);
    if (!res!.meta.changes) throw badRequest('Dieses Mitglied wurde gerade von jemand anderem übernommen.');
  } else {
    const me = (await getUser(ctx.db, ctx.userId))!;
    await ctx.db.batch([
      ctx.db.stmt('INSERT INTO members (group_id, user_id, name) VALUES (?, ?, ?)', invite.groupId, ctx.userId, me.name),
      activityStmt(ctx, invite.groupId, 'member.join', 'ist der Gruppe beigetreten'),
    ]);
  }
  return invite.groupId;
}

export async function listActivity(ctx: Ctx, groupId: number, limit = 50) {
  await requireMembership(ctx, groupId);
  const n = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
  const rows = await ctx.db.all<Row>(
    `SELECT a.id, a.action, a.summary, a.via, a.expense_id, a.created_at, u.name AS user_name, a.user_id
     FROM activity a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.group_id = ? ORDER BY a.id DESC LIMIT ?`,
    groupId,
    n,
  );
  return rows.map((r) => ({
    id: r.id as number,
    action: r.action as string,
    summary: r.summary as string,
    via: r.via as string,
    expenseId: (r.expense_id as number) ?? null,
    createdAt: r.created_at as string,
    user: r.user_id ? { id: r.user_id as number, name: r.user_name as string } : null,
  }));
}
