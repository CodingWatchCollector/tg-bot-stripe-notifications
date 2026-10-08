import type { PaymentReceived } from "../domain/payment";
import { PRODUCTS, productFor, type Products } from "../domain/products";
import type { RecordedPayment, Store } from "../db/store";
import type { Notifier } from "../notify/notifier";
import { paymentMessage, pickerButtons, unknownPayerText } from "./messages";

export function makeOnPaymentReceived(deps: {
  notifier: Notifier;
  store: Store;
  products?: Products;
}): (p: PaymentReceived) => Promise<void> {
  const { notifier, store, products = PRODUCTS } = deps;

  async function announce(row: RecordedPayment): Promise<{ messageId: number }> {
    if (row.status === "unassigned") {
      const students = await store.listActiveStudents();
      return notifier.send(unknownPayerText(row), { buttons: pickerButtons(row.id, students, row.customerName) });
    }
    const { text, buttons } = paymentMessage(row, { unarchived: row.unarchived });
    return buttons === undefined ? notifier.send(text) : notifier.send(text, { buttons });
  }

  return async (p) => {
    const matched = p.customerEmail === null ? null : await store.findStudentByEmail(p.customerEmail);
    const row = await store.recordPayment(p, matched, productFor(products, p.paymentLinkId));
    if (row.notifiedAt !== null) return;
    const { messageId } = await announce(row);
    await store.markNotified(row.id, messageId);
  };
}
