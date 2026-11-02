import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CATEGORY_IDS } from '../../shared/categories.js';
import { formatMoney, fromMinor } from '../../shared/money.js';
import { SPLIT_TYPES } from '../../shared/split.js';
import { AppError, badRequest } from '../errors.js';
import type { Ctx } from '../services/context.js';
import * as expenses from '../services/expenses.js';
import type { Expense, ExpenseInput, ExpenseUpdate } from '../services/expenses.js';
import * as groups from '../services/groups.js';
import type { Member } from '../services/groups.js';
import { getUser } from '../services/users.js';

const INSTRUCTIONS = `SplitApp verwaltet geteilte Ausgaben in Gruppen (wie Splitwise).
- Beträge werden immer in der Hauptwährungseinheit angegeben (12.5 = 12.50 CHF), nicht in Rappen/Cent.
- Mitglieder können per ID, per Name (Gross-/Kleinschreibung egal) oder mit "me" (der verbundene Benutzer) angegeben werden.
- Ein positiver Saldo bedeutet: diese Person bekommt Geld. Negativ: sie schuldet Geld.
- Ablauf: list_groups -> get_group (Mitglieder und Salden) -> list_expenses / create_expense / update_expense / delete_expense.
- Ausgleichszahlungen ("A hat B 20 CHF zurückgezahlt") mit record_payment erfassen, nicht als Ausgabe.
- Gelöschte Einträge lassen sich mit restore_expense wiederherstellen.
- Vor dem Löschen oder grösseren Änderungen kurz beim Benutzer nachfragen, wenn die Absicht nicht eindeutig ist.`;

const memberRef = z
  .union([z.number().int(), z.string().min(1)])
  .describe('Mitglieds-ID, Name des Mitglieds oder "me" für den verbundenen Benutzer');

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Datum im Format YYYY-MM-DD');

const currencySchema = z.string().length(3).describe('ISO-Währungscode, z. B. CHF, EUR, USD');

const splitTypeSchema = z
  .enum(SPLIT_TYPES)
  .describe(
    'equal = gleichmässig; exact = feste Beträge pro Person; percent = Prozent pro Person (Summe 100); shares = Anteile/Gewichte pro Person',
  );

const splitEntries = z
  .array(z.object({ member: memberRef, value: z.number().min(0) }))
  .describe('Für exact: Betrag pro Person; für percent: Prozent; für shares: Anteile. Nur nötig, wenn split_type nicht equal ist.');

const payersSchema = z
  .array(z.object({ member: memberRef, amount: z.number().min(0) }))
  .describe('Nur bei mehreren Zahlern: wer wie viel bezahlt hat (Summe = amount). Sonst paid_by verwenden.');

// --- Hilfsfunktionen ----------------------------------------------------------

function resolveMember(members: Member[], ref: number | string): Member {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const id = Number(ref);
    const m = members.find((x) => x.id === id);
    if (!m) throw badRequest(`Kein Mitglied mit ID ${id} in dieser Gruppe. Mitglieder: ${list(members)}`);
    return m;
  }
  const name = String(ref).trim().toLowerCase();
  if (['me', 'ich', 'mich', 'mir', 'myself'].includes(name)) {
    const me = members.find((m) => m.isMe);
    if (!me) throw badRequest('Du bist kein Mitglied dieser Gruppe.');
    return me;
  }
  const exact = members.filter((m) => m.name.toLowerCase() === name);
  if (exact.length === 1) return exact[0]!;
  const partial = members.filter((m) => m.name.toLowerCase().includes(name));
  if (exact.length === 0 && partial.length === 1) return partial[0]!;
  if (exact.length > 1 || partial.length > 1) {
    throw badRequest(`«${ref}» ist nicht eindeutig. Bitte die Mitglieds-ID verwenden. Mitglieder: ${list(members)}`);
  }
  throw badRequest(`Kein Mitglied «${ref}» gefunden. Mitglieder: ${list(members)}`);
}

const list = (members: Member[]) => members.map((m) => `${m.id}=${m.name}${m.isMe ? ' (du)' : ''}`).join(', ');

/** Erzeugt Links in die Web-App. */
export type LinkFn = (path: string) => string;
let link: LinkFn = (p) => p;
const groupUrl = (groupId: number) => link(`/groups/${groupId}`);
const expenseUrl = (e: Expense) => link(`/groups/${e.groupId}?expense=${e.id}`);

function money(minor: number, currency: string) {
  return { amount: fromMinor(minor, currency), formatted: formatMoney(minor, currency) };
}

function expenseOut(e: Expense, members: Member[]) {
  const name = (id: number) => members.find((m) => m.id === id)?.name ?? `#${id}`;
  const base = {
    id: e.id,
    group_id: e.groupId,
    type: e.kind,
    description: e.description,
    amount: fromMinor(e.amount, e.currency),
    currency: e.currency,
    amount_formatted: formatMoney(e.amount, e.currency),
    date: e.date,
  };
  if (e.kind === 'payment') {
    return {
      ...base,
      from: { member_id: e.payers[0]?.memberId, name: name(e.payers[0]?.memberId ?? 0) },
      to: { member_id: e.shares[0]?.memberId, name: name(e.shares[0]?.memberId ?? 0) },
      notes: e.notes,
      created_by: e.createdBy?.name ?? null,
      created_at: e.createdAt,
      updated_at: e.updatedAt,
      deleted: e.deletedAt !== null,
      url: expenseUrl(e),
    };
  }
  return {
    ...base,
    category: e.category,
    notes: e.notes,
    split_type: e.splitType,
    paid_by: e.payers.map((p) => ({ member_id: p.memberId, name: name(p.memberId), amount: fromMinor(p.amount, e.currency) })),
    split: e.shares.map((s) => ({
      member_id: s.memberId,
      name: name(s.memberId),
      owes: fromMinor(s.amount, e.currency),
      ...(e.splitType === 'percent' ? { percent: s.value } : e.splitType === 'shares' ? { shares: s.value } : {}),
    })),
    created_by: e.createdBy?.name ?? null,
    created_via: e.createdVia,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    deleted: e.deletedAt !== null,
    url: expenseUrl(e),
  };
}

async function groupOut(ctx: Ctx, groupId: number) {
  const g = await groups.getGroup(ctx, groupId);
  const name = (id: number) => g.members.find((m) => m.id === id)?.name ?? `#${id}`;
  return {
    id: g.id,
    name: g.name,
    default_currency: g.currency,
    url: groupUrl(g.id),
    your_member_id: g.myMemberId,
    members: g.members.map((m) => ({
      member_id: m.id,
      name: m.name,
      is_you: m.isMe,
      has_account: m.userId !== null,
      balances: g.balances
        .filter((b) => b.memberId === m.id && b.amount !== 0)
        .map((b) => ({ currency: b.currency, ...money(b.amount, b.currency) })),
    })),
    settle_up_suggestions: g.debts.map((d) => ({
      from: { member_id: d.from, name: name(d.from) },
      to: { member_id: d.to, name: name(d.to) },
      currency: d.currency,
      ...money(d.amount, d.currency),
    })),
    total_spent: g.totals.map((t) => ({ currency: t.currency, ...money(t.amount, t.currency) })),
  };
}

function ok(data: unknown, summary?: string): CallToolResult {
  const json = JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text: summary ? `${summary}\n\n${json}` : json }],
    structuredContent:
      data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data },
  };
}

function wrap<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: `Fehler: ${message}` }] };
    }
  };
}

interface SplitArgs {
  paid_by?: number | string;
  payers?: { member: number | string; amount: number }[];
  split_type?: (typeof SPLIT_TYPES)[number];
  split_among?: (number | string)[];
  split?: { member: number | string; value: number }[];
}

/** Übersetzt die Tool-Argumente zu Zahlern und Aufteilung in die Service-Eingabe. */
function splitInput(members: Member[], args: SplitArgs, isUpdate: boolean): Partial<ExpenseInput> {
  const out: Partial<ExpenseInput> = {};
  if (args.payers?.length) {
    out.payers = args.payers.map((p) => ({ memberId: resolveMember(members, p.member).id, amount: p.amount }));
  } else if (args.paid_by !== undefined) {
    out.payers = [{ memberId: resolveMember(members, args.paid_by).id }];
  } else if (!isUpdate) {
    out.payers = [{ memberId: resolveMember(members, 'me').id }];
  }

  if (args.split?.length) {
    out.splitType = args.split_type ?? (isUpdate ? undefined : 'exact');
    out.split = args.split.map((s) => ({ memberId: resolveMember(members, s.member).id, value: s.value }));
    if (out.splitType === 'equal') out.split = out.split.map((s) => ({ memberId: s.memberId }));
  } else if (args.split_among?.length) {
    if (args.split_type && args.split_type !== 'equal') {
      throw badRequest('Für split_type exact/percent/shares bitte «split» mit Werten statt «split_among» angeben.');
    }
    out.splitType = 'equal';
    out.split = args.split_among.map((ref) => ({ memberId: resolveMember(members, ref).id }));
  } else if (args.split_type) {
    if (args.split_type !== 'equal') throw badRequest(`Für split_type ${args.split_type} bitte «split» mit Werten angeben.`);
    out.splitType = 'equal';
    if (!isUpdate) out.split = members.map((m) => ({ memberId: m.id }));
  } else if (!isUpdate) {
    out.splitType = 'equal';
    out.split = members.map((m) => ({ memberId: m.id }));
  }
  return out;
}

// --- Server -----------------------------------------------------------------

export function buildMcpServer(ctx: Ctx, appUrl: string, linkFn: LinkFn): McpServer {
  link = linkFn;
  const server = new McpServer(
    { name: 'splitapp', title: 'SplitApp', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    'whoami',
    { title: 'Verbundenes Konto', description: 'Zeigt, mit welchem SplitApp-Konto diese Verbindung angemeldet ist.', annotations: readOnly },
    wrap(async () => {
      const u = (await getUser(ctx.db, ctx.userId))!;
      return ok({ user_id: u.id, name: u.name, email: u.email, app_url: appUrl });
    }),
  );

  server.registerTool(
    'list_groups',
    {
      title: 'Gruppen auflisten',
      description: 'Listet alle Gruppen des Benutzers mit seinem Saldo pro Gruppe (positiv = bekommt Geld, negativ = schuldet).',
      annotations: readOnly,
    },
    wrap(async () => {
      const list = (await groups.listGroups(ctx)).map((g) => ({
        id: g.id,
        name: g.name,
        default_currency: g.currency,
        members: g.memberCount,
        your_balance: g.myBalance.map((b) => ({ currency: b.currency, ...money(b.amount, b.currency) })),
        last_activity_at: g.lastActivityAt,
        url: groupUrl(g.id),
      }));
      return ok({ groups: list }, list.length ? undefined : 'Noch keine Gruppen vorhanden.');
    }),
  );

  server.registerTool(
    'get_group',
    {
      title: 'Gruppe anzeigen',
      description:
        'Details einer Gruppe: Mitglieder (mit IDs), Saldo pro Mitglied, vorgeschlagene Ausgleichszahlungen und Gesamtausgaben.',
      inputSchema: { group_id: z.number().int().describe('ID der Gruppe (aus list_groups)') },
      annotations: readOnly,
    },
    wrap(async ({ group_id }) => ok(await groupOut(ctx, group_id))),
  );

  server.registerTool(
    'get_balances',
    {
      title: 'Salden anzeigen',
      description:
        'Zeigt, wer wem wie viel schuldet. Ohne group_id: Übersicht über alle Gruppen aus Sicht des Benutzers. Mit group_id: Salden aller Mitglieder dieser Gruppe.',
      inputSchema: { group_id: z.number().int().optional().describe('Optional: nur diese Gruppe') },
      annotations: readOnly,
    },
    wrap(async ({ group_id }) => {
      if (group_id !== undefined) {
        const g = await groupOut(ctx, group_id);
        return ok({ group_id: g.id, group: g.name, members: g.members, settle_up_suggestions: g.settle_up_suggestions });
      }
      const totals = new Map<string, number>();
      const summaries = await groups.listGroups(ctx);
      const details = await Promise.all(summaries.map((s) => groups.getGroup(ctx, s.id)));
      const perGroup = summaries.map((s, i) => {
        const g = details[i]!;
        const name = (id: number) => g.members.find((m) => m.id === id)?.name ?? `#${id}`;
        for (const b of s.myBalance) totals.set(b.currency, (totals.get(b.currency) ?? 0) + b.amount);
        return {
          group_id: s.id,
          group: s.name,
          your_balance: s.myBalance.map((b) => ({ currency: b.currency, ...money(b.amount, b.currency) })),
          you_owe: g.debts
            .filter((d) => d.from === g.myMemberId)
            .map((d) => ({ to: name(d.to), currency: d.currency, ...money(d.amount, d.currency) })),
          owed_to_you: g.debts
            .filter((d) => d.to === g.myMemberId)
            .map((d) => ({ from: name(d.from), currency: d.currency, ...money(d.amount, d.currency) })),
        };
      });
      return ok({
        overall: [...totals].map(([currency, amount]) => ({ currency, ...money(amount, currency) })),
        groups: perGroup,
      });
    }),
  );

  server.registerTool(
    'list_expenses',
    {
      title: 'Einträge auflisten',
      description: 'Listet Ausgaben und Zahlungen einer Gruppe, neueste zuerst. Mit Filtern für Text, Mitglied und Zeitraum.',
      inputSchema: {
        group_id: z.number().int(),
        query: z.string().optional().describe('Volltextsuche in Beschreibung und Notizen'),
        member: memberRef.optional().describe('Nur Einträge, an denen dieses Mitglied beteiligt ist'),
        from_date: dateSchema.optional(),
        to_date: dateSchema.optional(),
        include_deleted: z.boolean().optional().describe('Auch gelöschte Einträge anzeigen'),
        limit: z.number().int().min(1).max(200).optional().describe('Standard 50'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: readOnly,
    },
    wrap(async (args) => {
      await groups.requireMembership(ctx, args.group_id);
      const members = await groups.listMembers(ctx, args.group_id);
      const result = await expenses.listExpenses(ctx, args.group_id, {
        query: args.query,
        memberId: args.member !== undefined ? resolveMember(members, args.member).id : undefined,
        fromDate: args.from_date,
        toDate: args.to_date,
        includeDeleted: args.include_deleted,
        limit: args.limit ?? 50,
        offset: args.offset,
      });
      return ok({
        total: result.total,
        offset: result.offset,
        returned: result.expenses.length,
        has_more: result.offset + result.expenses.length < result.total,
        expenses: result.expenses.map((e) => expenseOut(e, members)),
      });
    }),
  );

  server.registerTool(
    'get_expense',
    {
      title: 'Eintrag anzeigen',
      description: 'Zeigt eine einzelne Ausgabe oder Zahlung mit Zahlern und Aufteilung.',
      inputSchema: { expense_id: z.number().int() },
      annotations: readOnly,
    },
    wrap(async ({ expense_id }) => {
      const e = await expenses.getExpense(ctx, expense_id);
      return ok(expenseOut(e, await groups.listMembers(ctx, e.groupId)));
    }),
  );

  server.registerTool(
    'create_expense',
    {
      title: 'Ausgabe erfassen',
      description: `Erfasst eine neue Ausgabe in einer Gruppe.
Standard: bezahlt von "me", gleichmässig auf alle Mitglieder aufgeteilt.
Beispiele:
- "Ich habe 60 CHF fürs Abendessen mit Anna und Ben bezahlt": amount=60, split_among=["me","Anna","Ben"]
- "Ben hat 100 EUR Hotel bezahlt, ich 2 Nächte, Anna 1": paid_by="Ben", split_type="shares", split=[{member:"me",value:2},{member:"Anna",value:1}]
- "Miete 2000, ich 60 %, Anna 40 %": split_type="percent", split=[{member:"me",value:60},{member:"Anna",value:40}]`,
      inputSchema: {
        group_id: z.number().int(),
        description: z.string().min(1).max(200),
        amount: z.number().positive().describe('Gesamtbetrag in Hauptwährungseinheit, z. B. 42.5'),
        currency: currencySchema.optional().describe('Standard: Währung der Gruppe'),
        date: dateSchema.optional().describe('Standard: heute'),
        category: z.enum(CATEGORY_IDS).optional(),
        notes: z.string().max(2000).optional(),
        paid_by: memberRef.optional().describe('Wer hat bezahlt (Standard: "me")'),
        payers: payersSchema.optional(),
        split_type: splitTypeSchema.optional().describe('Standard: equal'),
        split_among: z.array(memberRef).optional().describe('Bei equal: unter wem aufgeteilt wird (Standard: alle Mitglieder)'),
        split: splitEntries.optional(),
      },
      annotations: write,
    },
    wrap(async (args) => {
      await groups.requireMembership(ctx, args.group_id);
      const members = await groups.listMembers(ctx, args.group_id);
      const input: ExpenseInput = {
        description: args.description,
        amount: args.amount,
        currency: args.currency,
        date: args.date,
        category: args.category,
        notes: args.notes,
        ...(splitInput(members, args, false) as Pick<ExpenseInput, 'payers' | 'splitType' | 'split'>),
      };
      const e = await expenses.createExpense(ctx, args.group_id, input);
      return ok(expenseOut(e, members), `Ausgabe #${e.id} «${e.description}» über ${formatMoney(e.amount, e.currency)} erfasst.`);
    }),
  );

  server.registerTool(
    'update_expense',
    {
      title: 'Eintrag ändern',
      description: `Ändert eine bestehende Ausgabe oder Zahlung. Nur die angegebenen Felder werden geändert.
Wird nur der Betrag geändert, bleibt die Aufteilung (gleichmässig/Prozent/Anteile) erhalten und wird neu berechnet.
Bei Zahlungen: paid_by = Sender, split_among = [Empfänger].`,
      inputSchema: {
        expense_id: z.number().int(),
        description: z.string().min(1).max(200).optional(),
        amount: z.number().positive().optional(),
        currency: currencySchema.optional(),
        date: dateSchema.optional(),
        category: z.enum(CATEGORY_IDS).optional(),
        notes: z.string().max(2000).nullable().optional().describe('null entfernt die Notiz'),
        paid_by: memberRef.optional(),
        payers: payersSchema.optional(),
        split_type: splitTypeSchema.optional(),
        split_among: z.array(memberRef).optional(),
        split: splitEntries.optional(),
      },
      annotations: { ...write, idempotentHint: true },
    },
    wrap(async (args) => {
      const existing = await expenses.getExpense(ctx, args.expense_id);
      const members = await groups.listMembers(ctx, existing.groupId);
      const patch: ExpenseUpdate = {
        description: args.description,
        amount: args.amount,
        currency: args.currency,
        date: args.date,
        category: existing.kind === 'payment' ? undefined : args.category,
        notes: args.notes,
        ...splitInput(members, args, true),
      };
      if (existing.kind === 'payment' && patch.split) {
        patch.splitType = 'exact';
        patch.split = patch.split.map((s) => ({ memberId: s.memberId, value: args.amount ?? fromMinor(existing.amount, existing.currency) }));
      }
      const e = await expenses.updateExpense(ctx, args.expense_id, patch);
      return ok(expenseOut(e, members), `Eintrag #${e.id} aktualisiert.`);
    }),
  );

  server.registerTool(
    'delete_expense',
    {
      title: 'Eintrag löschen',
      description: 'Löscht eine Ausgabe oder Zahlung. Kann mit restore_expense rückgängig gemacht werden.',
      inputSchema: { expense_id: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ expense_id }) => {
      const e = await expenses.deleteExpense(ctx, expense_id);
      return ok(
        { deleted: true, expense: expenseOut(e, await groups.listMembers(ctx, e.groupId)) },
        `Eintrag #${e.id} «${e.description}» gelöscht (wiederherstellbar mit restore_expense).`,
      );
    }),
  );

  server.registerTool(
    'restore_expense',
    {
      title: 'Eintrag wiederherstellen',
      description: 'Stellt einen gelöschten Eintrag wieder her.',
      inputSchema: { expense_id: z.number().int() },
      annotations: { ...write, idempotentHint: true },
    },
    wrap(async ({ expense_id }) => {
      const e = await expenses.restoreExpense(ctx, expense_id);
      return ok(expenseOut(e, await groups.listMembers(ctx, e.groupId)), `Eintrag #${e.id} wiederhergestellt.`);
    }),
  );

  server.registerTool(
    'record_payment',
    {
      title: 'Zahlung erfassen (ausgleichen)',
      description: 'Erfasst eine Ausgleichszahlung: "from" hat "to" Geld gegeben, z. B. um Schulden zu begleichen.',
      inputSchema: {
        group_id: z.number().int(),
        from: memberRef.describe('Wer hat bezahlt (Standard: "me")').optional(),
        to: memberRef.describe('Wer hat das Geld erhalten'),
        amount: z.number().positive(),
        currency: currencySchema.optional(),
        date: dateSchema.optional(),
        notes: z.string().max(2000).optional(),
      },
      annotations: write,
    },
    wrap(async (args) => {
      await groups.requireMembership(ctx, args.group_id);
      const members = await groups.listMembers(ctx, args.group_id);
      const from = resolveMember(members, args.from ?? 'me');
      const to = resolveMember(members, args.to);
      const e = await expenses.recordPayment(ctx, args.group_id, {
        fromMemberId: from.id,
        toMemberId: to.id,
        amount: args.amount,
        currency: args.currency,
        date: args.date,
        notes: args.notes,
      });
      return ok(expenseOut(e, members), `Zahlung von ${from.name} an ${to.name} über ${formatMoney(e.amount, e.currency)} erfasst.`);
    }),
  );

  server.registerTool(
    'create_group',
    {
      title: 'Gruppe erstellen',
      description:
        'Erstellt eine neue Gruppe. Der Benutzer ist automatisch Mitglied. Weitere Mitglieder werden als Platzhalter angelegt und können später per Einladungslink ihr Konto verknüpfen.',
      inputSchema: {
        name: z.string().min(1).max(80),
        currency: currencySchema.optional().describe('Standard: CHF'),
        members: z.array(z.string().min(1).max(80)).optional().describe('Namen weiterer Mitglieder'),
      },
      annotations: write,
    },
    wrap(async (args) => {
      const g = await groups.createGroup(ctx, { name: args.name, currency: args.currency, members: args.members });
      const out = await groupOut(ctx, g.id);
      return ok(
        { ...out, invite_link: link(`/join/${g.inviteToken}`) },
        `Gruppe «${g.name}» erstellt.`,
      );
    }),
  );

  server.registerTool(
    'add_member',
    {
      title: 'Mitglied hinzufügen',
      description: 'Fügt einer Gruppe ein Mitglied (Platzhalter mit Namen) hinzu.',
      inputSchema: { group_id: z.number().int(), name: z.string().min(1).max(80) },
      annotations: write,
    },
    wrap(async ({ group_id, name }) => {
      const m = await groups.addMember(ctx, group_id, name);
      return ok({ member_id: m.id, name: m.name, group_id }, `${m.name} wurde hinzugefügt.`);
    }),
  );

  server.registerTool(
    'list_activity',
    {
      title: 'Aktivität anzeigen',
      description: 'Zeigt den Änderungsverlauf einer Gruppe (wer hat wann was erfasst, geändert oder gelöscht).',
      inputSchema: { group_id: z.number().int(), limit: z.number().int().min(1).max(200).optional() },
      annotations: readOnly,
    },
    wrap(async ({ group_id, limit }) =>
      ok({
        activity: (await groups.listActivity(ctx, group_id, limit ?? 30)).map((a) => ({
          at: a.createdAt,
          who: a.user?.name ?? 'Unbekannt',
          via: a.via,
          what: a.summary,
          expense_id: a.expenseId,
        })),
      }),
    ),
  );

  // --- search / fetch: Kompatibilität mit ChatGPT (Connectors / Deep Research) --------

  server.registerTool(
    'search',
    {
      title: 'Suchen',
      description: 'Durchsucht alle Gruppen und Einträge des Benutzers nach einem Suchbegriff.',
      inputSchema: { query: z.string().describe('Suchbegriff, z. B. "Hotel" oder Gruppenname') },
      annotations: readOnly,
    },
    wrap(async ({ query }) => {
      const q = query.trim().toLowerCase();
      const groupHits = (await groups.listGroups(ctx))
        .filter((g) => !q || g.name.toLowerCase().includes(q))
        .map((g) => ({ id: `group:${g.id}`, title: `Gruppe: ${g.name}`, url: groupUrl(g.id) }));
      const expenseHits = q
        ? (await expenses.searchExpenses(ctx, q, 20)).map((e) => ({
            id: `expense:${e.id}`,
            title: `${e.description} (${formatMoney(e.amount, e.currency)}, ${e.date})`,
            url: expenseUrl(e),
          }))
        : [];
      const results = [...groupHits, ...expenseHits];
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }], structuredContent: { results } };
    }),
  );

  server.registerTool(
    'fetch',
    {
      title: 'Dokument abrufen',
      description: 'Ruft eine Gruppe ("group:<id>") oder einen Eintrag ("expense:<id>") aus den Suchergebnissen vollständig ab.',
      inputSchema: { id: z.string().describe('ID aus den Suchergebnissen, z. B. "expense:12"') },
      annotations: readOnly,
    },
    wrap(async ({ id }) => {
      const [type, rawId] = id.split(':');
      const num = Number(rawId);
      if (!Number.isInteger(num)) throw badRequest('Ungültige ID. Erwartet z. B. "group:3" oder "expense:12".');
      let doc;
      if (type === 'group') {
        const g = await groupOut(ctx, num);
        const recent = (await expenses.listExpenses(ctx, num, { limit: 20 })).expenses;
        const members = await groups.listMembers(ctx, num);
        doc = {
          id,
          title: `Gruppe: ${g.name}`,
          text: JSON.stringify({ ...g, recent_expenses: recent.map((e) => expenseOut(e, members)) }, null, 2),
          url: g.url,
          metadata: { type: 'group' },
        };
      } else if (type === 'expense') {
        const e = await expenses.getExpense(ctx, num);
        const out = expenseOut(e, await groups.listMembers(ctx, e.groupId));
        doc = { id, title: e.description, text: JSON.stringify(out, null, 2), url: out.url, metadata: { type: e.kind } };
      } else {
        throw badRequest('Unbekannter Typ. Erwartet "group:<id>" oder "expense:<id>".');
      }
      return { content: [{ type: 'text', text: JSON.stringify(doc) }], structuredContent: doc };
    }),
  );

  return server;
}
