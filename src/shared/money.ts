/** Geldbeträge werden intern immer als ganze Zahl in der kleinsten Einheit (z. B. Rappen) gespeichert. */

const digitsCache = new Map<string, number>();

export function currencyDigits(currency: string): number {
  const code = currency.toUpperCase();
  let digits = digitsCache.get(code);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    digitsCache.set(code, digits);
  }
  return digits;
}

export function isValidCurrency(currency: string): boolean {
  if (!/^[A-Za-z]{3}$/.test(currency)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() });
    return true;
  } catch {
    return false;
  }
}

/** 12.5 CHF -> 1250 */
export function toMinor(amount: number, currency: string): number {
  const factor = 10 ** currencyDigits(currency);
  return Math.round(amount * factor + Number.EPSILON * Math.sign(amount));
}

/** 1250 -> 12.5 */
export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}

export function formatMoney(minor: number, currency: string, locale = 'de-CH'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(
    fromMinor(minor, currency),
  );
}

/** Parst Benutzereingaben wie "12.50", "12,50" oder "1'250.00". */
export function parseAmountInput(input: string): number | null {
  const cleaned = input.trim().replace(/['’\s]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
