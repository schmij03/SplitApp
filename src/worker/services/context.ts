import type { Db } from '../db.js';

/** Wer handelt gerade? `via` ist "web" oder z. B. "mcp:Claude". */
export interface Ctx {
  db: Db;
  userId: number;
  via: string;
}

export function activityStmt(
  ctx: Ctx,
  groupId: number,
  action: string,
  summary: string,
  expenseId: number | null = null,
): D1PreparedStatement {
  return ctx.db.stmt(
    'INSERT INTO activity (group_id, user_id, via, action, expense_id, summary) VALUES (?, ?, ?, ?, ?, ?)',
    groupId,
    ctx.userId,
    ctx.via,
    action,
    expenseId,
    summary,
  );
}
