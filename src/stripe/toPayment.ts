import type Stripe from "stripe";
import type { PaymentReceived } from "../domain/payment";

export function toPaymentReceived(event: Stripe.Event): PaymentReceived | null {
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return null;
  }
  const session = event.data.object;
  if (session.payment_status !== "paid") return null;

  const details = session.customer_details;
  const intent = session.payment_intent;
  const link = session.payment_link;
  const email = [details?.email, session.customer_email].map((e) => e?.trim()).find((e) => e);
  return {
    amountMinor: session.amount_total ?? null,
    currency: session.currency ?? null,
    customerName: details?.name ?? details?.individual_name ?? details?.business_name ?? null,
    customerEmail: email?.toLowerCase() ?? null,
    paymentIntentId: typeof intent === "string" ? intent : (intent?.id ?? null),
    paymentLinkId: typeof link === "string" ? link : (link?.id ?? null),
    livemode: event.livemode,
    source: {
      provider: "stripe",
      eventId: event.id,
      checkoutSessionId: session.id,
      clientReferenceId: session.client_reference_id ?? null,
      metadata: session.metadata ?? {},
    },
  };
}
