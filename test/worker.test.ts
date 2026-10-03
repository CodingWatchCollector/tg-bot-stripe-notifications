import { Api } from "grammy";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { createTelegramNotifier } from "../src/notify/telegram";
import { createWorker } from "../src/worker";
import { paidEvent } from "./fixtures";

const FULL_ENV = {
  STRIPE_WEBHOOK_SECRET: "whsec_ac20secret",
  TELEGRAM_BOT_TOKEN: "777:ac20token",
  TELEGRAM_CHAT_ID: "-100777",
};

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

const logged = () => [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat();
const isJson = (res: Response) => expect(res.headers.get("content-type")).toMatch(/^application\/json/);

async function signedPaid(secret: string) {
  const payload = JSON.stringify(paidEvent());
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  return new Request("https://worker.test/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header },
    body: payload,
  });
}


describe("routing", () => {
  test("GET /stripe/webhook -> 405", async () => {
    const makeNotifier = vi.fn();
    const res = await createWorker({ makeNotifier }).fetch(
      new Request("https://worker.test/stripe/webhook"),
      FULL_ENV,
    );
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method not allowed" });
    expect(res.headers.get("allow")).toBe("POST");
    isJson(res);
    expect(makeNotifier).not.toHaveBeenCalled();
  });

  test.each([["POST"], ["GET"]])("%s /other -> 404", async (method) => {
    const makeNotifier = vi.fn();
    const res = await createWorker({ makeNotifier }).fetch(new Request("https://worker.test/other", { method }), FULL_ENV);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    isJson(res);
    expect(makeNotifier).not.toHaveBeenCalled();
  });

  test("routing happens before config", async () => {
    const worker = createWorker({ makeNotifier: vi.fn() });
    const notFound = await worker.fetch(new Request("https://worker.test/other", { method: "POST" }), {});
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: "not found" });
    const notAllowed = await worker.fetch(new Request("https://worker.test/stripe/webhook"), {});
    expect(notAllowed.status).toBe(405);
    expect(await notAllowed.json()).toEqual({ error: "method not allowed" });
  });
});

describe("configuration", () => {
  const rows = Object.keys(FULL_ENV).flatMap((name) => [
    [name, "absent"],
    [name, "blank"],
  ]);

  test.each(rows)("%s %s -> 500 misconfigured", async (name, kind) => {
    const env: Record<string, string> = { ...FULL_ENV };
    if (kind === "absent") delete env[name];
    else env[name] = "  ";
    const makeNotifier = vi.fn();
    const res = await createWorker({ makeNotifier }).fetch(await signedPaid(FULL_ENV.STRIPE_WEBHOOK_SECRET), env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "misconfigured" });
    isJson(res);
    expect(makeNotifier).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().some((a) => String(a).includes(name))).toBe(true);
    for (const arg of logged()) {
      for (const text of [String(arg), JSON.stringify(arg)]) {
        for (const value of Object.values(env)) {
          if (value.trim()) expect(text).not.toContain(value);
        }
      }
    }
  });

  test("makeNotifier throwing -> 500 internal without leaking", async () => {
    const makeNotifier = vi.fn(() => {
      throw new Error("boom SENTINEL_TOKEN");
    });
    const res = await createWorker({ makeNotifier }).fetch(await signedPaid(FULL_ENV.STRIPE_WEBHOOK_SECRET), FULL_ENV);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    isJson(res);
    expect(error.mock.calls.flat().some((a) => String(a).includes("Error"))).toBe(true);
    for (const arg of logged()) {
      expect(String(arg)).not.toContain("SENTINEL_TOKEN");
      expect(JSON.stringify(arg)).not.toContain("SENTINEL_TOKEN");
    }
  });
});

describe("wiring", () => {
  test("paid event reaches Telegram sendMessage", async () => {
    const calls: { method: string; payload: unknown }[] = [];
    const api = new Api("123:abc");
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: { message_id: 1 } } as never;
    });
    const makeNotifier = vi.fn((cfg: { telegramBotToken: string; telegramChatId: string }) =>
      createTelegramNotifier({ token: cfg.telegramBotToken, chatId: cfg.telegramChatId, api }),
    );
    const env = { STRIPE_WEBHOOK_SECRET: "whsec_wire", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" };
    const res = await createWorker({ makeNotifier }).fetch(await signedPaid("whsec_wire"), env);
    expect(res.status).toBe(200);
    expect(makeNotifier).toHaveBeenCalledWith({ telegramBotToken: "123:abc", telegramChatId: "42" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload).toMatchObject({
      chat_id: "42",
      text: "Payment received: 45.00 EUR\nCustomer: Anna K <anna@example.com>\nhttps://dashboard.stripe.com/payments/pi_123",
    });
  });
});

