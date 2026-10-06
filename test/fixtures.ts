import type Stripe from "stripe";
import type { PaymentReceived } from "../src/domain/payment";

export const expectedPayment: PaymentReceived = {
  amountMinor: 4500,
  currency: "eur",
  customerName: "Anna K",
  customerEmail: "anna@example.com",
  paymentIntentId: "pi_123",
  paymentLinkId: null,
  source: {
    provider: "stripe",
    eventId: "evt_1",
    checkoutSessionId: "cs_test_1",
    clientReferenceId: "stu_7",
    metadata: { student: "anna" },
  },
};

export function sessionEvent(
  type: string,
  session: Record<string, unknown> = {},
  event: Record<string, unknown> = {},
): Stripe.Event {
  return {
    id: "evt_1",
    object: "event",
    type,
    livemode: true,
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        payment_status: "paid",
        amount_total: 4500,
        currency: "eur",
        customer_details: { name: "Anna K", email: "anna@example.com" },
        customer_email: null,
        payment_intent: "pi_123",
        client_reference_id: "stu_7",
        metadata: { student: "anna" },
        ...session,
      },
    },
    ...event,
  } as unknown as Stripe.Event;
}

export const paidEvent = (): Stripe.Event => sessionEvent("checkout.session.completed");
