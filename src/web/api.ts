export interface User {
  id: number;
  email: string;
  name: string;
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
export interface Member {
  id: number;
  name: string;
  userId: number | null;
  isMe: boolean;
}
export interface Transfer {
  from: number;
  to: number;
  amount: number;
  currency: string;
}
export interface GroupDetail {
  id: number;
  name: string;
  currency: string;
  inviteToken: string;
  createdAt: string;
  myMemberId: number;
  members: Member[];
  balances: { memberId: number; currency: string; amount: number }[];
  debts: Transfer[];
  totals: BalanceLine[];
}
export type SplitType = 'equal' | 'exact' | 'percent' | 'shares';
export interface Expense {
  id: number;
  groupId: number;
  kind: 'expense' | 'payment';
  description: string;
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
export interface ExpenseInput {
  description: string;
  amount: number;
  currency?: string;
  date?: string;
  category?: string;
  notes?: string | null;
  payers: { memberId: number; amount?: number | null }[];
  splitType: SplitType;
  split: { memberId: number; value?: number | null }[];
}
export interface Activity {
  id: number;
  action: string;
  summary: string;
  via: string;
  expenseId: number | null;
  createdAt: string;
  user: { id: number; name: string } | null;
}
export interface Connection {
  id: string;
  clientName: string;
  redirectHost: string | null;
  connectedAt: string;
  expiresAt: string | null;
}
export interface Invite {
  groupId: number;
  name: string;
  currency: string;
  alreadyMember: boolean;
  members: { id: number; name: string; claimed: boolean }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Adresse des Cloudflare Workers (beim Build per VITE_API_URL gesetzt, sonst gleiche Domain). */
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

const TOKEN_KEY = 'splitapp_token';
export const tokenStore = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token: string | null) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* z. B. privater Modus */
    }
  },
};

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Server nicht erreichbar. Bitte Internetverbindung prüfen.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Fehler ${res.status}`);
  return data as T;
}
