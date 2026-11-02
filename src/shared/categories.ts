export const CATEGORIES = [
  { id: 'general', label: 'Allgemein', icon: '🧾' },
  { id: 'food', label: 'Essen & Trinken', icon: '🍽️' },
  { id: 'groceries', label: 'Lebensmittel', icon: '🛒' },
  { id: 'transport', label: 'Transport', icon: '🚆' },
  { id: 'fuel', label: 'Benzin', icon: '⛽' },
  { id: 'accommodation', label: 'Unterkunft', icon: '🏨' },
  { id: 'rent', label: 'Miete', icon: '🏠' },
  { id: 'utilities', label: 'Nebenkosten', icon: '💡' },
  { id: 'entertainment', label: 'Freizeit', icon: '🎟️' },
  { id: 'shopping', label: 'Einkäufe', icon: '🛍️' },
  { id: 'gifts', label: 'Geschenke', icon: '🎁' },
  { id: 'other', label: 'Sonstiges', icon: '📦' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]];

export function categoryInfo(id: string | null | undefined) {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0];
}
