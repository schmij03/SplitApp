import type { DB } from '../db.js';

/** Wer handelt gerade? `via` ist "web" oder z. B. "mcp:Claude". */
export interface Ctx {
  db: DB;
  userId: number;
  via: string;
}

export type Row = Record<string, any>;

export function logActivity(
  ctx: Ctx,
  groupId: number,
  action: string,
  summary: string,
  expenseId: number | null = null,
): void {
  ctx.db
    .prepare('INSERT INTO activity (group_id, user_id, via, action, expense_id, summary) VALUES (?, ?, ?, ?, ?, ?)')
    .run(groupId, ctx.userId, ctx.via, action, expenseId, summary);
}
