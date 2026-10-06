import { compareNames, nameKey, type Student } from "../domain/student";
import type { Button } from "../notify/notifier";

export interface PaymentFacts {
  amountMinor: number | null;
  currency: string | null;
  customerName: string | null;
  customerEmail: string | null;
  paymentIntentId: string | null;
}

export type EmailOutcome = "saved" | "none" | { ownedBy: { name: string } };

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

export const knownPayerText = (studentName: string, p: PaymentFacts): string =>
  withLink([`💶 ${studentName} paid ${formatAmount(p.amountMinor, p.currency)}`], p);

export function assignedText(studentName: string, p: PaymentFacts, email: EmailOutcome = "none"): string {
  const lines = [`💶 ${studentName} paid ${formatAmount(p.amountMinor, p.currency)}`];
  if (p.customerEmail !== null && email === "saved") lines.push(`${p.customerEmail} saved as ${studentName}'s email`);
  if (p.customerEmail !== null && typeof email === "object") {
    lines.push(`${p.customerEmail} already belongs to ${email.ownedBy.name}`);
  }
  return withLink(lines, p);
}

export const unknownPayerText = (p: PaymentFacts): string =>
  withLink(
    [`💶 Unknown payer paid ${formatAmount(p.amountMinor, p.currency)}`, customerLine(p), "Who is this?"],
    p,
  );

export const dismissedText = (p: PaymentFacts): string =>
  withLink([`💶 Payment dismissed: ${formatAmount(p.amountMinor, p.currency)}`, customerLine(p)], p);

const MAX_STUDENT_BUTTONS = 90;

export function pickerButtons(paymentId: number, students: Student[], customerName: string | null): Button[][] {
  const sorted = [...students].sort(compareNames);
  const key = customerName === null ? "" : nameKey(customerName);
  const suggested = key === "" ? undefined : sorted.find((s) => s.nameKey === key);

  const rows: Button[][] = [[{ text: "➕ New student", data: `p:${paymentId}:new` }]];
  if (suggested) rows.push([{ text: `💡 ${suggested.name}`, data: `p:${paymentId}:s:${suggested.id}` }]);

  const buttons = sorted
    .filter((s) => s !== suggested)
    .slice(0, MAX_STUDENT_BUTTONS - (suggested ? 1 : 0))
    .map((s): Button => ({ text: s.name, data: `p:${paymentId}:s:${s.id}` }));
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));

  rows.push([{ text: "✖️ Cancel", data: `p:${paymentId}:x` }]);
  return rows;
}

export const studentsText = (students: Student[]): string =>
  students.length === 0
    ? "No students yet."
    : [`Students (${students.length}):`, ...[...students].sort(compareNames).map((s) => s.name)].join("\n");

export const newStudentPrompt = (paymentId: number): string => `Name for the new student (payment #${paymentId}):`;
