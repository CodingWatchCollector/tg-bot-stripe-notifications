export interface PaymentReceived {
  amountMinor: number | null;
  currency: string | null;
  customerName: string | null;
  customerEmail: string | null;
  paymentIntentId: string | null;
  livemode: boolean;
  source: {
    provider: "stripe";
    eventId: string;
    checkoutSessionId: string;
    clientReferenceId: string | null;
    metadata: Record<string, string>;
  };
}
