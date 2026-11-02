/**
 * Aufteilungslogik einer Ausgabe. Alle Beträge in kleinster Einheit (ganzzahlig).
 *
 * - equal:   gleichmässig auf alle Teilnehmer
 * - exact:   value = exakter Betrag pro Person (kleinste Einheit), Summe muss dem Total entsprechen
 * - percent: value = Prozent pro Person, Summe muss 100 ergeben
 * - shares:  value = Anteile/Gewichte pro Person (z. B. 2 Nächte vs. 1 Nacht)
 */

export const SPLIT_TYPES = ['equal', 'exact', 'percent', 'shares'] as const;
export type SplitType = (typeof SPLIT_TYPES)[number];

export interface SplitEntry {
  memberId: number;
  /** Für exact: Betrag in kleinster Einheit, für percent: Prozent, für shares: Gewicht. Bei equal ignoriert. */
  value?: number | null;
}

export interface ShareResult {
  memberId: number;
  amount: number;
  /** Ursprünglicher Eingabewert, damit eine Ausgabe später wieder gleich bearbeitet werden kann. */
  value: number | null;
}

export class SplitError extends Error {}

/** Verteilt `total` proportional zu `weights` (Methode des grössten Rests), Summe stimmt immer exakt. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0 || sum <= 0) throw new SplitError('Mindestens eine Person mit positivem Anteil nötig.');
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * w) / sum);
  const floors = raw.map((r) => Math.floor(r + 1e-9));
  let remainder = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    floors[order[k]!.i]! += 1;
  }
  return floors.map((f) => f * sign);
}

export function computeShares(total: number, type: SplitType, entries: SplitEntry[]): ShareResult[] {
  if (!Number.isInteger(total) || total <= 0) throw new SplitError('Der Betrag muss grösser als 0 sein.');
  const seen = new Set<number>();
  for (const e of entries) {
    if (seen.has(e.memberId)) throw new SplitError('Eine Person kommt in der Aufteilung doppelt vor.');
    seen.add(e.memberId);
  }
  if (entries.length === 0) throw new SplitError('Die Ausgabe muss auf mindestens eine Person aufgeteilt werden.');

  switch (type) {
    case 'equal': {
      const amounts = allocate(total, entries.map(() => 1));
      return entries.map((e, i) => ({ memberId: e.memberId, amount: amounts[i]!, value: null }));
    }
    case 'exact': {
      const values = entries.map((e) => {
        const v = e.value ?? 0;
        if (!Number.isInteger(v) || v < 0) throw new SplitError('Exakte Beträge müssen positiv sein.');
        return v;
      });
      const sum = values.reduce((a, b) => a + b, 0);
      if (sum !== total) {
        throw new SplitError(`Die exakten Beträge ergeben ${sum}, das Total ist aber ${total} (kleinste Einheit).`);
      }
      return entries
        .map((e, i) => ({ memberId: e.memberId, amount: values[i]!, value: values[i]! }))
        .filter((s) => s.amount > 0);
    }
    case 'percent': {
      const values = entries.map((e) => {
        const v = e.value ?? 0;
        if (!Number.isFinite(v) || v < 0) throw new SplitError('Prozentwerte müssen positiv sein.');
        return v;
      });
      const sum = values.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > 0.01) throw new SplitError(`Die Prozente ergeben ${round(sum)} % statt 100 %.`);
      const amounts = allocate(total, values);
      return entries
        .map((e, i) => ({ memberId: e.memberId, amount: amounts[i]!, value: values[i]! }))
        .filter((s) => s.value > 0);
    }
    case 'shares': {
      const values = entries.map((e) => {
        const v = e.value ?? 0;
        if (!Number.isFinite(v) || v < 0) throw new SplitError('Anteile müssen positiv sein.');
        return v;
      });
      const amounts = allocate(total, values);
      return entries
        .map((e, i) => ({ memberId: e.memberId, amount: amounts[i]!, value: values[i]! }))
        .filter((s) => s.value > 0);
    }
    default:
      throw new SplitError(`Unbekannte Aufteilungsart: ${String(type)}`);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
