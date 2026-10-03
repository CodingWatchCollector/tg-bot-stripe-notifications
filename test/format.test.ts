import { describe, expect, test } from "vitest";
import type { PaymentReceived } from "../src/domain/payment";
import { formatPaymentMessage } from "../src/notify/format";

const base: PaymentReceived = {
  amountMinor: 4500,
  currency: "eur",
  customerName: "Anna K",
  customerEmail: "anna@example.com",
  paymentIntentId: "pi_123",
  livemode: true,
  source: {
    provider: "stripe",
    eventId: "evt_1",
    checkoutSessionId: "cs_test_1",
    clientReferenceId: null,
    metadata: {},
  },
};

const firstLine = (p: PaymentReceived) => formatPaymentMessage(p).split("\n")[0];

describe("formatPaymentMessage", () => {
  test("full message", () => {
    expect(formatPaymentMessage(base)).toBe(
      "Payment received: 45.00 EUR\nCustomer: Anna K <anna@example.com>\nhttps://dashboard.stripe.com/payments/pi_123",
    );
  });

  test("test-mode link", () => {
    expect(formatPaymentMessage({ ...base, livemode: false }).split("\n")[2]).toBe(
      "https://dashboard.stripe.com/test/payments/pi_123",
    );
  });

  test("no payment intent omits link line", () => {
    expect(formatPaymentMessage({ ...base, paymentIntentId: null })).toBe(
      "Payment received: 45.00 EUR\nCustomer: Anna K <anna@example.com>",
    );
  });

  const zero = "bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf".split(" ");
  test.each(zero)("zero-decimal %s", (code) => {
    expect(firstLine({ ...base, amountMinor: 5000, currency: code })).toBe(
      `Payment received: 5000 ${code.toUpperCase()}`,
    );
  });

  test.each("bhd jod kwd omr tnd".split(" "))("three-decimal %s", (code) => {
    expect(firstLine({ ...base, amountMinor: 12345, currency: code })).toBe(
      `Payment received: 12.345 ${code.toUpperCase()}`,
    );
  });

  test.each("huf isk twd eur usd".split(" "))("two-decimal %s", (code) => {
    expect(firstLine({ ...base, amountMinor: 100000, currency: code })).toBe(
      `Payment received: 1000.00 ${code.toUpperCase()}`,
    );
  });

  test.each([
    [null, null, "Customer: unknown <unknown>"],
    ["Anna K", null, "Customer: Anna K <unknown>"],
    [null, "anna@example.com", "Customer: unknown <anna@example.com>"],
  ])("customer line name=%s email=%s", (customerName, customerEmail, line) => {
    expect(formatPaymentMessage({ ...base, customerName, customerEmail }).split("\n")[1]).toBe(line);
  });

  test("unknown amount", () => {
    expect(firstLine({ ...base, amountMinor: null })).toBe("Payment received: amount unknown");
  });

  test("unknown currency", () => {
    expect(firstLine({ ...base, currency: null })).toBe("Payment received: amount unknown");
  });
});
