import { describe, expect, test } from "vitest";
import { toPaymentReceived } from "../src/stripe/toPayment";
import { expectedPayment, paidEvent, sessionEvent } from "./fixtures";

const completed = (session: Record<string, unknown>) =>
  toPaymentReceived(sessionEvent("checkout.session.completed", session));

describe("toPaymentReceived", () => {
  test("maps a paid checkout session", () => {
    expect(toPaymentReceived(paidEvent())).toEqual(expectedPayment);
  });

  test("livemode comes from the event", () => {
    const event = sessionEvent("checkout.session.completed", {}, { livemode: false });
    expect(toPaymentReceived(event)?.livemode).toBe(false);
  });

  test("async_payment_succeeded is mapped too", () => {
    expect(toPaymentReceived(sessionEvent("checkout.session.async_payment_succeeded"))).toEqual(expectedPayment);
  });

  test("payment_intent object -> its id", () => {
    expect(completed({ payment_intent: { id: "pi_456", object: "payment_intent" } })?.paymentIntentId).toBe("pi_456");
  });

  test("payment_intent null -> null", () => {
    expect(completed({ payment_intent: null })?.paymentIntentId).toBeNull();
  });

  test("customer_details null falls back to customer_email", () => {
    const p = completed({ customer_details: null, customer_email: "x@example.com" });
    expect(p?.customerName).toBeNull();
    expect(p?.customerEmail).toBe("x@example.com");
  });

  test("name falls back to individual_name then business_name; email to customer_email", () => {
    const details = { name: null, individual_name: "Ivan P", business_name: "Acme", email: null };
    const p = completed({ customer_details: details, customer_email: "y@example.com" });
    expect(p?.customerName).toBe("Ivan P");
    expect(p?.customerEmail).toBe("y@example.com");
    expect(completed({ customer_details: { ...details, individual_name: null } })?.customerName).toBe("Acme");
  });

  test("customer_details.email wins over customer_email", () => {
    const p = completed({ customer_details: { email: "a@example.com" }, customer_email: "b@example.com" });
    expect(p?.customerEmail).toBe("a@example.com");
  });

  test.each([
    ["a string", "plink_1", "plink_1"],
    ["an expanded object", { id: "plink_1", object: "payment_link" }, "plink_1"],
    ["null", null, null],
  ])("payment_link as %s", (_name, payment_link, expected) => {
    expect(completed({ payment_link })?.paymentLinkId).toBe(expected);
  });

  test("payment_link absent -> null", () => {
    expect(completed({})?.paymentLinkId).toBeNull();
  });

  test("email is trimmed and lowercased", () => {
    expect(completed({ customer_details: { email: " Anna@X.com " } })?.customerEmail).toBe("anna@x.com");
  });

  test("blank customer_details.email falls back to customer_email", () => {
    const p = completed({ customer_details: { email: "  " }, customer_email: "b@x.com" });
    expect(p?.customerEmail).toBe("b@x.com");
  });

  test("blank or absent emails -> null", () => {
    expect(completed({ customer_details: { email: "  " }, customer_email: " " })?.customerEmail).toBeNull();
    expect(completed({ customer_details: null, customer_email: null })?.customerEmail).toBeNull();
  });

  test("null metadata -> {}", () => {
    expect(completed({ metadata: null })?.source.metadata).toEqual({});
  });

  test("null client_reference_id", () => {
    expect(completed({ client_reference_id: null })?.source.clientReferenceId).toBeNull();
  });

  test("null amount and currency stay null", () => {
    const p = completed({ amount_total: null, currency: null });
    expect(p?.amountMinor).toBeNull();
    expect(p?.currency).toBeNull();
  });

  test.each([
    ["payment_intent.succeeded", "paid"],
    ["checkout.session.expired", "paid"],
    ["charge.succeeded", "paid"],
    ["checkout.session.completed", "unpaid"],
    ["checkout.session.completed", "no_payment_required"],
    ["checkout.session.async_payment_succeeded", "unpaid"],
    ["checkout.session.async_payment_succeeded", "no_payment_required"],
  ])("%s with %s -> null", (type, payment_status) => {
    expect(toPaymentReceived(sessionEvent(type, { payment_status }))).toBeNull();
  });
});
