export interface PaymentReceived {
  amountMinor: number | null;
  currency: string | null;
  customerName: string | null;
  customerEmail: string | null;
  paymentIntentId: string | null;
  paymentLinkId: string | null;
  source: {
    provider: "stripe";
    eventId: string;
    checkoutSessionId: string;
    clientReferenceId: string | null;
    metadata: Record<string, string>;
  };
}
