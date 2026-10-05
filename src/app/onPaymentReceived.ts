import type { PaymentReceived } from "../domain/payment";
import type { Store, PaymentView } from "../db/store";
import type { Notifier } from "../notify/notifier";
import { dismissedText, knownPayerText, pickerButtons, unknownPayerText } from "./messages";

export function makeOnPaymentReceived(deps: { notifier: Notifier; store: Store }): (p: PaymentReceived) => Promise<void> {
  const { notifier, store } = deps;

  async function announce(row: PaymentView): Promise<{ messageId: number }> {
    if (row.status === "assigned") return notifier.send(knownPayerText(row.studentName ?? "unknown", row));
    if (row.status === "dismissed") return notifier.send(dismissedText(row));
    const students = await store.listActiveStudents();
    return notifier.send(unknownPayerText(row), { buttons: pickerButtons(row.id, students, row.customerName) });
  }

  return async (p) => {
    const matched = p.customerEmail === null ? null : await store.findStudentByEmail(p.customerEmail);
    const row = await store.recordPayment(p, matched);
    if (row.notifiedAt !== null) return;
    const { messageId } = await announce(row);
    await store.markNotified(row.id, messageId);
  };
}
