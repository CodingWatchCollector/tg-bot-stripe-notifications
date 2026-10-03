import type { PaymentReceived } from "../domain/payment";

// Stripe's minor-unit digits differ from ISO 4217 for some currencies (HUF, ISK, TWD), so Intl is not used.
const ZERO_DECIMAL = new Set("bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf".split(" "));
const THREE_DECIMAL = new Set("bhd jod kwd omr tnd".split(" "));

function digits(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

export function formatPaymentMessage(p: PaymentReceived): string {
  const currency = p.currency?.toLowerCase();
  const amount =
    p.amountMinor === null || currency === undefined
      ? "amount unknown"
      : `${(p.amountMinor / 10 ** digits(currency)).toFixed(digits(currency))} ${currency.toUpperCase()}`;
  const lines = [
    `Payment received: ${amount}`,
    `Customer: ${p.customerName ?? "unknown"} <${p.customerEmail ?? "unknown"}>`,
  ];
  if (p.paymentIntentId !== null) {
    const base = p.livemode ? "https://dashboard.stripe.com" : "https://dashboard.stripe.com/test";
    lines.push(`${base}/payments/${p.paymentIntentId}`);
  }
  return lines.join("\n");
}
