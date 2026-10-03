import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { handleStripeWebhook } from "../src/http/stripeWebhook";
import { NotifyError } from "../src/notify/notifier";
import { expectedPayment, paidEvent, sessionEvent } from "./fixtures";

const SECRET = "whsec_test";

async function post(body: string, opts: { secret?: string; timestamp?: number; header?: string | null } = {}) {
  const header =
    opts.header !== undefined
      ? opts.header
      : await Stripe.webhooks.generateTestHeaderStringAsync({
          payload: body,
          secret: opts.secret ?? SECRET,
          timestamp: opts.timestamp,
          cryptoProvider: Stripe.createSubtleCryptoProvider(),
        });
  const headers: Record<string, string> = {};
  if (header !== null) headers["stripe-signature"] = header;
  return new Request("https://worker.test/stripe/webhook", { method: "POST", headers, body });
}

const bodyOf = (event: unknown) => JSON.stringify(event);

type Spy = Mock<(...args: unknown[]) => void>;
let log: Spy;
let warn: Spy;
let error: Spy;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as Spy;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as unknown as Spy;
  error = vi.spyOn(console, "error").mockImplementation(() => {}) as unknown as Spy;
});
afterEach(() => vi.restoreAllMocks());

const loggedArgs = () => [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat();
const isJson = (res: Response) => expect(res.headers.get("content-type")).toMatch(/^application\/json/);

describe("handleStripeWebhook", () => {
  test("paid checkout session notifies once", async () => {
    const onPaymentReceived = vi.fn().mockResolvedValue(undefined);
    const res = await handleStripeWebhook(await post(bodyOf(paidEvent())), { webhookSecret: SECRET, onPaymentReceived });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    isJson(res);
    expect(onPaymentReceived).toHaveBeenCalledTimes(1);
    expect(onPaymentReceived.mock.calls[0]?.[0]).toEqual(expectedPayment);
  });

  test.each([
    ["checkout.session.async_payment_succeeded", "paid", 1],
    ["checkout.session.completed", "unpaid", 0],
    ["checkout.session.completed", "no_payment_required", 0],
    ["payment_intent.succeeded", "paid", 0],
    ["checkout.session.expired", "paid", 0],
  ])("%s / %s -> 200, called %i times", async (type, payment_status, calls) => {
    const onPaymentReceived = vi.fn().mockResolvedValue(undefined);
    const res = await handleStripeWebhook(await post(bodyOf(sessionEvent(type, { payment_status }))), {
      webhookSecret: SECRET,
      onPaymentReceived,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    isJson(res);
    expect(onPaymentReceived).toHaveBeenCalledTimes(calls);
  });

  test("verified event logs its id and type only", async () => {
    const onPaymentReceived = vi.fn().mockResolvedValue(undefined);
    await handleStripeWebhook(await post(bodyOf(paidEvent())), { webhookSecret: SECRET, onPaymentReceived });
    expect(log).toHaveBeenCalledWith("stripe event received:", "evt_1", "checkout.session.completed");
    for (const arg of loggedArgs()) {
      expect(String(arg)).not.toContain("anna@example.com");
      expect(JSON.stringify(arg)).not.toContain("anna@example.com");
    }
  });

  describe("signature rejection", () => {
    const body = bodyOf(paidEvent());
    const cases: [string, () => Promise<Request>][] = [
      ["missing header", () => post(body, { header: null })],
      ["other secret", () => post(body, { secret: "whsec_other" })],
      [
        "tampered body",
        async () => {
          const req = await post(body);
          const header = req.headers.get("stripe-signature");
          return post(body.replace("4500", "9999"), { header });
        },
      ],
      ["old timestamp", () => post(body, { timestamp: Math.floor(Date.now() / 1000) - 600 })],
    ];

    test.each(cases)("%s -> 400", async (_name, makeRequest) => {
      const onPaymentReceived = vi.fn();
      const res = await handleStripeWebhook(await makeRequest(), { webhookSecret: SECRET, onPaymentReceived });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid signature" });
      isJson(res);
      expect(onPaymentReceived).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("stripe signature rejected:");
      for (const arg of loggedArgs()) {
        expect(String(arg)).not.toContain("anna@example.com");
        expect(JSON.stringify(arg)).not.toContain("anna@example.com");
      }
    });
  });

  test("notifier failure -> 500 with safe log", async () => {
    const onPaymentReceived = vi.fn().mockRejectedValue(new NotifyError("telegram 403: Forbidden"));
    const res = await handleStripeWebhook(await post(bodyOf(paidEvent())), { webhookSecret: SECRET, onPaymentReceived });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "processing failed" });
    isJson(res);
    const args = error.mock.calls.flat().map(String);
    expect(args.some((a) => a.includes("telegram 403: Forbidden"))).toBe(true);
    expect(args.some((a) => a.includes("evt_1"))).toBe(true);
    expect(args.some((a) => a.includes("NotifyError"))).toBe(true);
  });

  test("non-JSON signed body -> 500 internal without leaking the body", async () => {
    const onPaymentReceived = vi.fn();
    const res = await handleStripeWebhook(await post("not json"), { webhookSecret: SECRET, onPaymentReceived });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    isJson(res);
    expect(onPaymentReceived).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().some((a) => String(a).includes("SyntaxError"))).toBe(true);
    for (const arg of loggedArgs()) {
      expect(String(arg)).not.toContain("not json");
      expect(JSON.stringify(arg)).not.toContain("not json");
    }
  });

  test("rejection details never reach the logs", async () => {
    const failure = Object.assign(new Error("SENTINEL_TOKEN_123:abc", { cause: "SENTINEL_TOKEN_123:abc" }), {
      error: "SENTINEL_TOKEN_123:abc",
    });
    const onPaymentReceived = vi.fn().mockRejectedValue(failure);
    const res = await handleStripeWebhook(await post(bodyOf(paidEvent())), { webhookSecret: SECRET, onPaymentReceived });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "processing failed" });
    isJson(res);
    for (const arg of loggedArgs()) {
      for (const text of [String(arg), JSON.stringify(arg)]) {
        expect(text).not.toContain("SENTINEL_TOKEN");
        expect(text).not.toContain("anna@example.com");
      }
    }
  });
});
