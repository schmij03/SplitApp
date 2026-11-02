/** Saldo- und Schuldenberechnung. Positiver Saldo = bekommt Geld, negativer Saldo = schuldet Geld. */

export interface LedgerEntry {
  currency: string;
  payers: { memberId: number; amount: number }[];
  shares: { memberId: number; amount: number }[];
}

export interface Transfer {
  from: number;
  to: number;
  amount: number;
  currency: string;
}

/** Liefert pro Währung eine Map memberId -> Saldo. */
export function computeBalances(entries: LedgerEntry[]): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  for (const e of entries) {
    let m = result.get(e.currency);
    if (!m) result.set(e.currency, (m = new Map()));
    for (const p of e.payers) m.set(p.memberId, (m.get(p.memberId) ?? 0) + p.amount);
    for (const s of e.shares) m.set(s.memberId, (m.get(s.memberId) ?? 0) - s.amount);
  }
  return result;
}

/**
 * Vereinfacht Schulden: Statt jede Ausgabe einzeln auszugleichen, wird mit möglichst wenigen
 * Zahlungen ausgeglichen (grösster Schuldner zahlt grösstem Gläubiger).
 */
export function simplifyDebts(balances: Map<number, number>, currency: string): Transfer[] {
  const creditors: { id: number; amt: number }[] = [];
  const debtors: { id: number; amt: number }[] = [];
  for (const [id, amt] of balances) {
    if (amt > 0) creditors.push({ id, amt });
    else if (amt < 0) debtors.push({ id, amt: -amt });
  }
  const byAmount = (a: { id: number; amt: number }, b: { id: number; amt: number }) => b.amt - a.amt || a.id - b.id;
  creditors.sort(byAmount);
  debtors.sort(byAmount);

  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!;
    const c = creditors[j]!;
    const amount = Math.min(d.amt, c.amt);
    if (amount > 0) transfers.push({ from: d.id, to: c.id, amount, currency });
    d.amt -= amount;
    c.amt -= amount;
    if (d.amt === 0) i++;
    if (c.amt === 0) j++;
  }
  return transfers;
}
