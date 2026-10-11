export interface Student {
  id: number;
  name: string;
  nameKey: string;
  telegramUsername: string | null;
  archived: boolean;
  createdAt: string;
}

export const normalizeName = (s: string): string => s.trim().replace(/\s+/g, " ");

export const nameKey = (s: string): string => normalizeName(s).toLowerCase();

const collator = new Intl.Collator("en", { sensitivity: "base" });

export const compareNames = (a: { id: number; name: string }, b: { id: number; name: string }): number =>
  collator.compare(a.name, b.name) || a.id - b.id;

const hasLength = (s: string, max: number): boolean => {
  const length = [...normalizeName(s)].length;
  return length >= 1 && length <= max;
};

export const isValidName = (s: string): boolean => hasLength(s, 64);

export const isValidReason = (s: string): boolean => hasLength(s, 200);

export const normalizeEmail = (s: string): string => s.trim().toLowerCase();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Takes a normalized address. Loose on purpose: a typo is an Owner mistake, not a security boundary.
export const isValidEmail = (s: string): boolean => [...s].length <= 254 && EMAIL.test(s);

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export function parseUsername(s: string): { username: string | null } | null {
  const text = s.trim();
  if (text === "-") return { username: null };
  const username = text.startsWith("@") ? text.slice(1) : text;
  return USERNAME.test(username) ? { username } : null;
}
