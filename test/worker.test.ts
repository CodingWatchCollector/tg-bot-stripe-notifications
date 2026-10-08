import { Api } from "grammy";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { createTelegramNotifier } from "../src/notify/telegram";
import type { Env } from "../src/config";
import { createWorker } from "../src/worker";
import { paidEvent, sessionEvent } from "./fixtures";
import { createD1Fake, type D1Fake } from "./support/d1";
import { createStore } from "../src/db/store";
import { PRODUCTS_FIXTURE, addAdjustment, addStudent } from "./support/seed";

const FULL_ENV = {
  STRIPE_WEBHOOK_SECRET: "whsec_ac20secret",
  TELEGRAM_BOT_TOKEN: "777:ac20token",
  TELEGRAM_CHAT_ID: "-100777",
  TELEGRAM_WEBHOOK_SECRET: "tg_secret",
  DB: undefined as unknown as D1Database,
};

let fake: D1Fake;
const env = (over: Record<string, unknown> = {}): Env => ({ ...FULL_ENV, DB: fake.d1, ...over }) as Env;
const makeBot = vi.fn();

type Spy = Mock<(...args: unknown[]) => void>;
let log: Spy;
let warn: Spy;
let error: Spy;

beforeEach(() => {
  fake = createD1Fake();
  log = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as Spy;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as unknown as Spy;
  error = vi.spyOn(console, "error").mockImplementation(() => {}) as unknown as Spy;
});
afterEach(() => vi.restoreAllMocks());

const logged = () => [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat();
const isJson = (res: Response) => expect(res.headers.get("content-type")).toMatch(/^application\/json/);

async function signedPaid(secret: string, event: Stripe.Event = paidEvent()) {
  const payload = JSON.stringify(event);
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
    const res = await createWorker({ makeNotifier, makeBot }).fetch(
      new Request("https://worker.test/stripe/webhook"),
      env(),
    );
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method not allowed" });
    expect(res.headers.get("allow")).toBe("POST");
    isJson(res);
    expect(makeNotifier).not.toHaveBeenCalled();
  });

  test.each([["POST"], ["GET"]])("%s /other -> 404", async (method) => {
    const makeNotifier = vi.fn();
    const res = await createWorker({ makeNotifier, makeBot }).fetch(new Request("https://worker.test/other", { method }), env());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    isJson(res);
    expect(makeNotifier).not.toHaveBeenCalled();
  });

  test("routing happens before config", async () => {
    const worker = createWorker({ makeNotifier: vi.fn(), makeBot });
    const notFound = await worker.fetch(new Request("https://worker.test/other", { method: "POST" }), {});
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: "not found" });
    const notAllowed = await worker.fetch(new Request("https://worker.test/stripe/webhook"), {});
    expect(notAllowed.status).toBe(405);
    expect(await notAllowed.json()).toEqual({ error: "method not allowed" });
  });
});

describe("configuration", () => {
  const stripeRows = ["STRIPE_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].flatMap((name) => [
    [name, "absent"],
    [name, "blank"],
  ]);

  async function expectMisconfigured(res: Response, name: string, e: Record<string, unknown>) {
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "misconfigured" });
    isJson(res);
    expect(error.mock.calls.flat().some((a) => String(a).includes(name))).toBe(true);
    for (const arg of logged()) {
      for (const text of [String(arg), JSON.stringify(arg)]) {
        for (const value of Object.values(e)) {
          if (typeof value === "string" && value.trim()) expect(text).not.toContain(value);
        }
      }
    }
  }

  test.each(stripeRows)("Stripe route: %s %s -> 500 misconfigured", async (name, kind) => {
    const e = env({ [name as string]: kind === "absent" ? undefined : "  " });
    const makeNotifier = vi.fn();
    const res = await createWorker({ makeNotifier, makeBot }).fetch(await signedPaid(FULL_ENV.STRIPE_WEBHOOK_SECRET), e);
    await expectMisconfigured(res, name as string, e as unknown as Record<string, unknown>);
    expect(makeNotifier).not.toHaveBeenCalled();
  });

  test("Stripe route: DB absent -> 500 misconfigured naming DB", async () => {
    const e = env({ DB: undefined });
    const makeNotifier = vi.fn();
    const res = await createWorker({ makeNotifier, makeBot }).fetch(await signedPaid(FULL_ENV.STRIPE_WEBHOOK_SECRET), e);
    await expectMisconfigured(res, "DB", e as unknown as Record<string, unknown>);
    expect(makeNotifier).not.toHaveBeenCalled();
  });

  test("Stripe route: TELEGRAM_WEBHOOK_SECRET absent -> still processed", async () => {
    const { api } = recordingApi();
    const makeNotifier = () => createTelegramNotifier({ token: "t", chatId: "-100777", api });
    const res = await createWorker({ makeNotifier, makeBot }).fetch(
      await signedPaid(FULL_ENV.STRIPE_WEBHOOK_SECRET),
      env({ TELEGRAM_WEBHOOK_SECRET: undefined }),
    );
    expect(res.status).toBe(200);
  });

  const telegramRows = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET"].flatMap((name) => [
    [name, "absent"],
    [name, "blank"],
  ]);

  const tgRequest = () =>
    new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "tg_secret" },
      body: "{}",
    });

  test.each(telegramRows)("Telegram route: %s %s -> 500 misconfigured", async (name, kind) => {
    const e = env({ [name as string]: kind === "absent" ? undefined : "  " });
    const res = await createWorker({ makeNotifier: vi.fn(), makeBot }).fetch(tgRequest(), e);
    await expectMisconfigured(res, name as string, e as unknown as Record<string, unknown>);
    expect(makeBot).not.toHaveBeenCalled();
  });

  test("Telegram route: DB absent -> 500 misconfigured naming DB", async () => {
    const e = env({ DB: undefined });
    const res = await createWorker({ makeNotifier: vi.fn(), makeBot }).fetch(tgRequest(), e);
    await expectMisconfigured(res, "DB", e as unknown as Record<string, unknown>);
  });

  test("all missing keys are listed in one line, in route order", async () => {
    const worker = createWorker({ makeNotifier: vi.fn(), makeBot });
    await worker.fetch(await signedPaid("whsec_x"), {});
    await worker.fetch(tgRequest(), {});
    const lines = error.mock.calls.filter((c) => c[0] === "missing configuration:").map((c) => c[1]);
    expect(lines).toEqual([
      "STRIPE_WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DB",
      "TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, DB",
    ]);
  });

  test("makeNotifier throwing -> 500 internal without leaking", async () => {
    const makeNotifier = vi.fn(() => {
      throw new Error("boom SENTINEL_TOKEN");
    });
    const res = await createWorker({ makeNotifier, makeBot }).fetch(await signedPaid(FULL_ENV.STRIPE_WEBHOOK_SECRET), env());
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

function recordingApi(respond: () => unknown = () => ({ ok: true, result: { message_id: 55 } })) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = new Api("123:abc");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return respond() as never;
  });
  return { api, calls };
}

const LINK = "https://dashboard.stripe.com/payments/pi_123";
const rows = () => fake.raw.all("SELECT status, student_id, message_id, notified_at, customer_email FROM payments");

async function deliver(
  session: Record<string, unknown> = {},
  opts: { api?: Api; type?: string; id?: string; livemode?: boolean } = {},
) {
  const recorded = recordingApi();
  const api = opts.api ?? recorded.api;
  const makeNotifier = () => createTelegramNotifier({ token: "123:abc", chatId: "-100777", api });
  const event = sessionEvent(
    opts.type ?? "checkout.session.completed",
    { amount_total: 16000, ...session },
    { ...(opts.id && { id: opts.id }), ...(opts.livemode !== undefined && { livemode: opts.livemode }) },
  );
  const res = await createWorker({ makeNotifier, makeBot, products: PRODUCTS_FIXTURE }).fetch(
    await signedPaid(FULL_ENV.STRIPE_WEBHOOK_SECRET, event),
    env(),
  );
  return { res, calls: recorded.calls };
}

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
    const e = env({ STRIPE_WEBHOOK_SECRET: "whsec_wire", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" });
    const res = await createWorker({ makeNotifier, makeBot }).fetch(await signedPaid("whsec_wire"), e);
    expect(res.status).toBe(200);
    expect(makeNotifier).toHaveBeenCalledWith({ telegramBotToken: "123:abc", telegramChatId: "42" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload).toMatchObject({
      chat_id: "42",
      text: `💶 Unknown payer paid 45,00\u00a0€\nAnna K <anna@example.com>\nWho is this?\n${LINK}`,
    });
  });
});

describe("Stripe delivery", () => {
  test("known payer: one message without buttons, row assigned", async () => {
    const olena = addStudent(fake, "Olena", { emails: ["olena@example.com"] });
    const { res, calls } = await deliver({ customer_details: { name: "Whoever", email: " OLENA@Example.com " } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.text).toBe(`💶 Olena paid 160,00\u00a0€\n${LINK}`);
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
    expect(rows()).toMatchObject([{ status: "assigned", student_id: olena, message_id: 55 }]);
    expect(rows()[0]?.notified_at).not.toBeNull();
  });

  test("a test-mode event still gets the live dashboard link", async () => {
    const { calls } = await deliver({}, { livemode: false });
    expect(String(calls[0]?.payload.text).endsWith(`\n${LINK}`)).toBe(true);
  });

  test("archived payer is announced by name and stays archived", async () => {
    addStudent(fake, "Old One", { emails: ["old@example.com"], archived: true });
    const { calls } = await deliver({ customer_details: { name: "X", email: "old@example.com" } });
    expect(calls[0]?.payload.text).toBe(`💶 Old One paid 160,00\u00a0€\n${LINK}`);
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
    expect(fake.raw.all("SELECT archived FROM students")).toEqual([{ archived: 1 }]);
  });

  test("unknown payer gets the picker", async () => {
    addStudent(fake, "Olena", { emails: ["olena@example.com"] });
    const ira = addStudent(fake, "Ira + Pasha");
    addStudent(fake, "Old One", { archived: true });
    const { calls } = await deliver();
    expect(calls[0]?.payload.text).toBe(`💶 Unknown payer paid 160,00\u00a0€\nAnna K <anna@example.com>\nWho is this?\n${LINK}`);
    const keyboard = (calls[0]?.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(keyboard.map((r) => r.map((b) => b.text))).toEqual([["➕ New student"], ["Ira + Pasha", "Olena"], ["✖️ Cancel"]]);
    expect(keyboard[1]?.[0]?.callback_data).toBe(`p:1:s:${ira}`);
    expect(rows()).toMatchObject([{ status: "unassigned", message_id: 55 }]);
  });

  test("the customer name suggests a student", async () => {
    const olena = addStudent(fake, "Olena");
    const { calls } = await deliver({ customer_details: { name: " olena ", email: "x@example.com" } });
    const keyboard = (calls[0]?.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(keyboard[1]).toEqual([{ text: "💡 Olena", callback_data: `p:1:s:${olena}` }]);
    expect(keyboard.flat().filter((b) => b.text === "Olena")).toHaveLength(0);
  });

  test.each([
    ["no email", { customer_details: { name: "Anna K" }, customer_email: null }],
    ["blank email", { customer_details: { name: "Anna K", email: "  " }, customer_email: null }],
  ])("%s -> unknown payer with an unknown email", async (_n, session) => {
    const { calls } = await deliver(session);
    expect(calls[0]?.payload.text).toContain("Anna K <unknown>");
    expect(calls[0]?.payload.reply_markup).toBeDefined();
  });

  test.each(["checkout.session.completed", "checkout.session.async_payment_succeeded"])(
    "a repeat delivery of a notified session (%s) sends nothing",
    async (type) => {
      await deliver();
      const { res, calls } = await deliver({}, { type, id: "evt_2" });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(0);
      expect(rows()).toHaveLength(1);
    },
  );

  test("resend after a Telegram failure renders the stored status", async () => {
    const failing = recordingApi(() => ({ ok: false, error_code: 500, description: "boom" }));
    const first = await deliver({}, { api: failing.api });
    expect(first.res.status).toBe(500);
    expect(await first.res.json()).toEqual({ error: "processing failed" });
    expect(rows()).toMatchObject([{ status: "unassigned", notified_at: null }]);

    addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const second = await deliver();
    expect(second.res.status).toBe(200);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.payload.text).toContain("Unknown payer");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.notified_at).not.toBeNull();
  });

  test("a D1 failure -> 500 processing failed, no message, safe log", async () => {
    fake.failNext();
    const { res, calls } = await deliver();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "processing failed" });
    expect(calls).toHaveLength(0);
    expect(error.mock.calls.flat().some((a) => String(a).includes("Error"))).toBe(true);
    expect(error.mock.calls.flat().some((a) => String(a).includes("evt_1"))).toBe(true);
    for (const arg of logged()) {
      for (const text of [String(arg), JSON.stringify(arg)]) {
        expect(text).not.toContain("anna@example.com");
        expect(text).not.toContain("Anna K");
        expect(text).not.toContain("Unknown payer");
      }
    }
  });

  test("unpaid sessions and other events leave no row", async () => {
    await deliver({ payment_status: "unpaid" });
    await deliver({}, { type: "payment_intent.succeeded" });
    expect(rows()).toHaveLength(0);
  });
});

describe("Stripe delivery with products", () => {
  const T4 = "Індивідуальний пакет 4";
  const CLUB = "Клуб B2/C1 — поурочно";
  const EUR = "160,00\u00a0€";
  const olenaPayer = { customer_details: { name: "Whoever", email: "olena@example.com" } };
  const balances = async () => Object.fromEntries((await createStore(fake.d1).listStudentBalances()).map((b) => [b.name, b.balance]));
  const keyboard = (pid: number) => ({
    inline_keyboard: [[{ text: "-1", callback_data: `p:${pid}:-1` }, { text: "+1", callback_data: `p:${pid}:+1` }]],
  });
  const seedOlena = (balance = 1) => {
    const id = addStudent(fake, "Olena", { emails: ["olena@example.com"] });
    if (balance !== 0) addAdjustment(fake, id, balance);
    return id;
  };
  const paymentRows = () => fake.raw.all("SELECT id, status, lessons, product_name, message_id, notified_at FROM payments ORDER BY id");

  test("a Pack from a known payer is announced with the Balance and correction buttons", async () => {
    seedOlena();
    const { res, calls } = await deliver({ ...olenaPayer, payment_link: "plink_t4" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.text).toBe(`💶 Olena paid for 4 lessons (${T4}, ${EUR})\nBalance: 1 → 5\n${LINK}`);
    expect(calls[0]?.payload.reply_markup).toEqual(keyboard(1));
    expect(paymentRows()).toMatchObject([{ status: "assigned", lessons: 4, product_name: T4, message_id: 55 }]);
    expect(paymentRows()[0]?.notified_at).not.toBeNull();
    expect((await balances()).Olena).toBe(5);
  });

  test("a single lesson is singular", async () => {
    seedOlena();
    const { calls } = await deliver({ ...olenaPayer, payment_link: "plink_t1" });
    expect(calls[0]?.payload.text).toBe(`💶 Olena paid for 1 lesson (Індивідуальне — поурочно, ${EUR})\nBalance: 1 → 2\n${LINK}`);
  });

  test("Individual and Duo Packs credit one Balance", async () => {
    addStudent(fake, "Ira + Pasha", { emails: ["ira@example.com"] });
    const ira = { customer_details: { name: "Ira", email: "ira@example.com" } };
    const first = await deliver({ ...ira, payment_link: "plink_d4" });
    const second = await deliver({ ...ira, payment_link: "plink_t1", id: "cs_test_2" });
    expect(first.calls[0]?.payload.text).toBe(`💶 Ira + Pasha paid for 4 lessons (Duo — пакет 4, ${EUR})\nBalance: 0 → 4\n${LINK}`);
    expect(String(second.calls[0]?.payload.text)).toContain("\nBalance: 4 → 5\n");
    expect((await balances())["Ira + Pasha"]).toBe(5);
  });

  test("a name-only product is announced by name and leaves the Balance alone", async () => {
    seedOlena();
    const { calls } = await deliver({ ...olenaPayer, payment_link: "plink_club" });
    expect(calls[0]?.payload.text).toBe(`💶 Olena paid ${EUR} for ${CLUB}\n${LINK}`);
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
    expect(paymentRows()).toMatchObject([{ status: "assigned", lessons: 0, product_name: CLUB }]);
    expect((await balances()).Olena).toBe(1);
  });

  test.each([
    ["no link", {}],
    ["a link outside the table", { payment_link: "plink_other" }],
  ])("%s keeps today's text", async (_n, link) => {
    seedOlena();
    const { calls } = await deliver({ ...olenaPayer, ...link });
    expect(calls[0]?.payload.text).toBe(`💶 Olena paid ${EUR}\n${LINK}`);
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
    expect(paymentRows()).toMatchObject([{ lessons: 0, product_name: null }]);
    expect((await balances()).Olena).toBe(1);
  });

  test.each([
    ["a name-only product", { payment_link: "plink_club" }],
    ["no link", {}],
  ])("an archived payer with %s stays archived with no unarchive line", async (_n, link) => {
    addStudent(fake, "Old One", { emails: ["old@example.com"], archived: true });
    const { calls } = await deliver({ customer_details: { name: "X", email: "old@example.com" }, ...link });
    expect(String(calls[0]?.payload.text)).not.toContain("active again");
    expect(String(calls[0]?.payload.text).startsWith("💶 Old One paid")).toBe(true);
    expect(fake.raw.all("SELECT archived FROM students")).toEqual([{ archived: 1 }]);
  });

  test.each(["checkout.session.completed", "checkout.session.async_payment_succeeded"])(
    "a repeat delivery (%s) never credits twice",
    async (type) => {
      seedOlena();
      await deliver({ ...olenaPayer, payment_link: "plink_t4" });
      const again = await deliver({ ...olenaPayer, payment_link: "plink_t4" }, { type, id: "evt_2" });
      expect(again.res.status).toBe(200);
      expect(again.calls).toHaveLength(0);
      expect(paymentRows()).toHaveLength(1);
      expect((await balances()).Olena).toBe(5);
    },
  );

  test("a delivery after a failed send announces the Balance once and credits once", async () => {
    seedOlena();
    const failing = recordingApi(() => ({ ok: false, error_code: 500, description: "boom" }));
    const first = await deliver({ ...olenaPayer, payment_link: "plink_t4" }, { api: failing.api });
    expect(first.res.status).toBe(500);
    expect(await first.res.json()).toEqual({ error: "processing failed" });
    expect(paymentRows()[0]?.notified_at).toBeNull();
    const second = await deliver({ ...olenaPayer, payment_link: "plink_t4" });
    expect(second.calls).toHaveLength(1);
    expect(String(second.calls[0]?.payload.text)).toContain("\nBalance: 1 → 5\n");
    expect((await balances()).Olena).toBe(5);
  });

  test.each([
    ["a Pack", { payment_link: "plink_t4" }, `💶 Unknown payer paid for 4 lessons (${T4}, ${EUR})`, 4],
    ["a name-only product", { payment_link: "plink_club" }, `💶 Unknown payer paid ${EUR} for ${CLUB}`, 0],
    ["no link", {}, `💶 Unknown payer paid ${EUR}`, 0],
  ])("an unknown payer with %s gets the picker and no Credit", async (_n, link, first, lessons) => {
    addStudent(fake, "Olena", { emails: ["olena@example.com"] });
    const { calls } = await deliver(link);
    expect(calls[0]?.payload.text).toBe(`${first}\nAnna K <anna@example.com>\nWho is this?\n${LINK}`);
    expect(calls[0]?.payload.reply_markup).toBeDefined();
    expect(paymentRows()).toMatchObject([{ status: "unassigned", lessons }]);
    expect(await balances()).toEqual({ Olena: 0 });
  });

  test("a Pack from an archived payer credits and unarchives in one batch", async () => {
    const oldOne = addStudent(fake, "Old One", { emails: ["old@example.com"], archived: true });
    const batch = vi.spyOn(fake, "batch");
    const { calls } = await deliver({ customer_details: { name: "X", email: "old@example.com" }, payment_link: "plink_t4" });
    expect(calls[0]?.payload.text).toBe(
      `💶 Old One paid for 4 lessons (${T4}, ${EUR})\nOld One was archived and is active again.\nBalance: 0 → 4\n${LINK}`,
    );
    expect(calls[0]?.payload.reply_markup).toEqual(keyboard(1));
    expect(fake.raw.all("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
    expect((await createStore(fake.d1).listActiveStudents()).map((s) => s.id)).toEqual([oldOne]);
    expect(batch).toHaveBeenCalledTimes(1);
    const sql = (batch.mock.calls[0]?.[0] as unknown as { sql: string }[]).map((st) => st.sql);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain("INSERT INTO payments");
    expect(sql[1]).toContain("UPDATE students SET archived = 0");
  });
});
