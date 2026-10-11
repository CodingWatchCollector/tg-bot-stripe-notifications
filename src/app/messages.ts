import type { PaymentView, StudentCard, StudentSummary } from "../db/store";
import { compareNames, nameKey, type Student } from "../domain/student";
import type { Button } from "../notify/notifier";
import { callbackData, emailTag, type StudentAction } from "./callbacks";

export interface PaymentFacts {
  amountMinor: number | null;
  currency: string | null;
  customerName: string | null;
  customerEmail: string | null;
  paymentIntentId: string | null;
  lessons?: number;
  productName?: string | null;
}

export type EmailOutcome = "saved" | "none" | { ownedBy: { name: string } };
export interface PaymentNotes {
  email?: EmailOutcome;
  unarchived?: boolean;
}
export type { StudentSummary } from "../db/store";

export function formatAmount(amountMinor: number | null, currency: string | null): string {
  if (amountMinor === null || currency === null) return "amount unknown";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency.toUpperCase() }).format(amountMinor / 100);
}

export const dashboardLink = (paymentIntentId: string | null): string | null =>
  paymentIntentId === null ? null : `https://dashboard.stripe.com/payments/${paymentIntentId}`;

export const customerLine = (p: Pick<PaymentFacts, "customerName" | "customerEmail">): string =>
  `${p.customerName ?? "unknown"} <${p.customerEmail ?? "unknown"}>`;

const withLink = (lines: string[], p: PaymentFacts): string => {
  const link = dashboardLink(p.paymentIntentId);
  return (link === null ? lines : [...lines, link]).join("\n");
};

const isPack = (p: PaymentFacts): boolean => (p.lessons ?? 0) > 0;

export const unarchivedLine = (name: string): string => `${name} was archived and is active again.`;

const lessonCount = (n: number): string => (n === 1 ? "1 lesson" : `${n} lessons`);

export function paidPhrase(p: PaymentFacts): string {
  const amount = formatAmount(p.amountMinor, p.currency);
  if (isPack(p)) return `paid for ${lessonCount(p.lessons ?? 0)} (${p.productName ?? "unknown product"}, ${amount})`;
  if ((p.productName ?? null) !== null) return `paid ${amount} for ${p.productName}`;
  return `paid ${amount}`;
}

const emailLine = (studentName: string, p: PaymentFacts, email: EmailOutcome): string | null => {
  if (p.customerEmail === null) return null;
  if (email === "saved") return `${p.customerEmail} saved as ${studentName}'s email`;
  if (typeof email === "object") return `${p.customerEmail} already belongs to ${email.ownedBy.name}`;
  return null;
};

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export function assignedText(studentName: string, p: PaymentFacts, email: EmailOutcome = "none"): string {
  const lines = [`💶 ${studentName} ${paidPhrase(p)}`];
  const note = emailLine(studentName, p, email);
  if (note !== null) lines.push(note);
  return withLink(lines, p);
}

export const unknownPayerText = (p: PaymentFacts): string =>
  withLink([`💶 Unknown payer ${paidPhrase(p)}`, customerLine(p), "Who is this?"], p);

export const dismissedText = (p: PaymentFacts): string => {
  const product = p.productName ?? null;
  const header = `💶 Payment dismissed: ${formatAmount(p.amountMinor, p.currency)}${product === null ? "" : ` for ${product}`}`;
  return withLink([header, customerLine(p)], p);
};

export const paymentButtons = (paymentId: number): Button[][] => [
  [
    { text: "-1", data: callbackData({ kind: "adjust_payment", paymentId, delta: -1 }) },
    { text: "+1", data: callbackData({ kind: "adjust_payment", paymentId, delta: 1 }) },
  ],
];

export function paymentMessage(view: PaymentView, notes: PaymentNotes = {}): { text: string; buttons?: Button[][] } {
  switch (view.status) {
    case "dismissed":
      return { text: dismissedText(view) };
    case "unassigned":
      return { text: unknownPayerText(view) };
    case "assigned": {
      const name = view.studentName ?? "unknown";
      if (!isPack(view)) return { text: assignedText(name, view, notes.email ?? "none") };
      if (view.studentBalance === null) throw new Error("assigned payment without balance");
      const lines = [`💶 ${name} ${paidPhrase(view)}`];
      const note = emailLine(name, view, notes.email ?? "none");
      if (note !== null) lines.push(note);
      if (notes.unarchived === true) lines.push(unarchivedLine(name));
      if (view.correction !== 0) lines.push(`Correction: ${signed(view.correction)}`);
      lines.push(`Balance: ${view.studentBalance - view.lessons - view.correction} → ${view.studentBalance}`);
      return { text: withLink(lines, view), buttons: paymentButtons(view.id) };
    }
  }
}

const MAX_STUDENT_BUTTONS = 90;

export function pickerButtons(paymentId: number, students: Student[], customerName: string | null): Button[][] {
  const sorted = [...students].sort(compareNames);
  const key = customerName === null ? "" : nameKey(customerName);
  const suggested = key === "" ? undefined : sorted.find((s) => s.nameKey === key);

  const rows: Button[][] = [[{ text: "➕ New student", data: callbackData({ kind: "new_student", paymentId }) }]];
  if (suggested) rows.push([{ text: `💡 ${suggested.name}`, data: callbackData({ kind: "assign", paymentId, studentId: suggested.id }) }]);

  const buttons = sorted
    .filter((s) => s !== suggested)
    .slice(0, MAX_STUDENT_BUTTONS - (suggested ? 1 : 0))
    .map((s): Button => ({ text: s.name, data: callbackData({ kind: "assign", paymentId, studentId: s.id }) }));
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));

  rows.push([{ text: "✖️ Cancel", data: callbackData({ kind: "dismiss", paymentId }) }]);
  return rows;
}

export const studentsText = (students: StudentSummary[]): string =>
  students.length === 0
    ? "No students yet."
    : [`Students (${students.length}):`, ...[...students].sort(compareNames).map((s) => `${s.name}: ${s.balance}`)].join("\n");

export const adjustText = (name: string, delta: number, reason: string, before: number, after: number, unarchived: boolean): string =>
  `${name}: ${signed(delta)} (${reason}). Balance: ${before} → ${after}` +
  (unarchived ? `\n${unarchivedLine(name)}` : "");

export function studentListButtons(students: StudentSummary[]): Button[][] {
  const buttons = [...students]
    .sort(compareNames)
    .slice(0, MAX_STUDENT_BUTTONS)
    .map((s): Button => ({ text: s.name, data: callbackData({ kind: "student", studentId: s.id, action: "open" }) }));
  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

export const archivedText = (students: StudentSummary[]): string =>
  students.length === 0
    ? "No archived students."
    : [`Archived students (${students.length}):`, ...[...students].sort(compareNames).map((s) => `${s.name}: ${s.balance}`)].join("\n");

const cardText = (card: StudentCard, note?: string): string =>
  [
    ...(note === undefined ? [] : [note]),
    `👤 ${card.name}${card.archived ? " (archived)" : ""}`,
    `Balance: ${card.balance}`,
    `Emails: ${card.emails.length === 0 ? "none" : card.emails.join(", ")}`,
    `Telegram: ${card.telegramUsername === null ? "not set" : `@${card.telegramUsername}`}`,
  ].join("\n");

export function cardMessage(card: StudentCard, note?: string): { text: string; buttons: Button[][] } {
  const button = (text: string, action: StudentAction): Button => ({
    text,
    data: callbackData({ kind: "student", studentId: card.id, action }),
  });
  return {
    text: cardText(card, note),
    buttons: [
      [button("-1", "-1"), button("+1", "+1")],
      [button("✏️ Rename", "name"), button("👤 Username", "user")],
      [button("➕ Email", "email+"), ...(card.emails.length > 0 ? [button("➖ Email", "email-")] : [])],
      [card.archived ? button("📤 Unarchive", "unarchive") : button("🗄 Archive", "archive")],
    ],
  };
}

export const emailRemovalButtons = (card: StudentCard): Button[][] => [
  ...card.emails.map((email): Button[] => [
    { text: `✖️ ${email}`, data: callbackData({ kind: "remove_email", studentId: card.id, tag: emailTag(email) }) },
  ]),
  [{ text: "⬅️ Back", data: callbackData({ kind: "student", studentId: card.id, action: "card" }) }],
];
