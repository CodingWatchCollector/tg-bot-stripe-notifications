import type { PaymentReceived } from "../domain/payment";
import { toPaymentReceived } from "../stripe/toPayment";
import { verifyStripeEvent } from "../stripe/verify";
import { errName, json, safeDetail } from "./respond";

export interface WebhookDeps {
  webhookSecret: string;
  onPaymentReceived: (p: PaymentReceived) => Promise<void>;
}

export async function handleStripeWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const raw = await request.text();

  let event;
  try {
    event = await verifyStripeEvent(raw, request.headers.get("stripe-signature"), deps.webhookSecret);
  } catch (err) {
    if ((err as { type?: unknown } | null)?.type === "StripeSignatureVerificationError") {
      console.warn("stripe signature rejected:", (err as Error).message);
      return json(400, { error: "invalid signature" });
    }
    console.error("webhook failed before verification completed:", errName(err));
    return json(500, { error: "internal" });
  }
  console.log("stripe event received:", event.id, event.type);

  let payment: PaymentReceived | null;
  try {
    payment = toPaymentReceived(event);
  } catch (err) {
    console.error("webhook mapping failed:", errName(err), event.id);
    return json(500, { error: "internal" });
  }

  if (payment !== null) {
    try {
      await deps.onPaymentReceived(payment);
    } catch (err) {
      const detail = safeDetail(err);
      console.error("payment processing failed:", errName(err), event.id, ...(detail === undefined ? [] : [detail]));
      return json(500, { error: "processing failed" });
    }
  }
  return json(200, { received: true });
}
