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

export function isValidName(s: string): boolean {
  const length = [...normalizeName(s)].length;
  return length >= 1 && length <= 64;
}
