import type { PaymentReceived } from "../domain/payment";
import { formatPaymentMessage } from "../notify/format";
import type { Notifier } from "../notify/notifier";

// v2 hook: dedupe, student match and balance update go here.
export function makeOnPaymentReceived(deps: { notifier: Notifier }): (p: PaymentReceived) => Promise<void> {
  return async (p) => deps.notifier.send(formatPaymentMessage(p));
}
