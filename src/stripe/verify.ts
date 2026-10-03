import Stripe from "stripe";

export function verifyStripeEvent(rawBody: string, signature: string | null, secret: string): Promise<Stripe.Event> {
  return Stripe.webhooks.constructEventAsync(
    rawBody,
    signature ?? "",
    secret,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}
