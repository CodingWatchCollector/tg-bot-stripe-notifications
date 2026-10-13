import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { makeOnPaymentReceived } from "../src/app/onPaymentReceived";
import { createBot } from "../src/bot/bot";
import { helpText } from "../src/app/commands";
import { createStore, type Store } from "../src/db/store";
import { createWorker } from "../src/worker";
import { createD1Fake, type D1Fake } from "./support/d1";
import type { Product } from "../src/domain/products";
import { PRODUCTS_FIXTURE, addAdjustment, addCalendarName, addIgnoredTitle, addStudent, payment } from "./support/seed";

const CHAT = "-100777";
const SECRET = "tg_secret";
const BOT = { id: 999, is_bot: true, first_name: "Tutor", username: "tutor_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as never;
const LINK = "https://dashboard.stripe.com/payments/pi_123";
const OLD = `💶 Unknown payer paid 160,00\u00a0€\nAnna K <anna@example.com>\nWho is this?\n${LINK}`;

type Call = { method: string; payload: Record<string, unknown> };
let fake: D1Fake;
let store: Store;
let calls: Call[];
let respond: (method: string, payload: Record<string, unknown>) => unknown | Promise<unknown>;
let makeBot: Mock;
let log: Mock;
let error: Mock;
let nextId: number;

const botFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  calls.push({ method, payload });
  const out = await respond(method, payload);
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

beforeEach(() => {
  fake = createD1Fake();
  store = createStore(fake.d1);
  calls = [];
  nextId = 100;
  respond = (method) => ({ ok: true, result: method === "sendMessage" ? { message_id: nextId++ } : true });
  makeBot = vi.fn(async (_cfg: unknown, s: Store) => createBot({ token: "777:tok", chatId: CHAT, store: s, botInfo: BOT, fetch: botFetch }));
  log = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as Mock;
  error = vi.spyOn(console, "error").mockImplementation(() => {}) as unknown as Mock;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const env = (over: Record<string, unknown> = {}) =>
  ({ TELEGRAM_BOT_TOKEN: "777:tok", TELEGRAM_CHAT_ID: CHAT, TELEGRAM_WEBHOOK_SECRET: SECRET, STRIPE_WEBHOOK_SECRET: "whsec", DB: fake.d1, ...over }) as never;

const worker = () => createWorker({ makeNotifier: vi.fn(), makeBot });

async function post(update: unknown, opts: { secret?: string | null; body?: string; e?: never } = {}) {
  const headers: Record<string, string> = {};
  if (opts.secret !== null) headers["x-telegram-bot-api-secret-token"] = opts.secret ?? SECRET;
  return worker().fetch(
    new Request("https://worker.test/telegram/webhook", { method: "POST", headers, body: opts.body ?? JSON.stringify(update) }),
    opts.e ?? env(),
  );
}

let updateId = 1;
const from = { id: 5, is_bot: false, first_name: "Owner" };
const chat = (id: string) => ({ id: Number(id), type: "supergroup", title: "G" });
const message = (text: string, o: { chat?: string; reply?: { text: string; fromId: number } } = {}) => ({
  update_id: updateId++,
  message: {
    message_id: 1,
    date: 1,
    chat: chat(o.chat ?? CHAT),
    from,
    text,
    ...(text.startsWith("/") && { entities: [{ type: "bot_command", offset: 0, length: text.split(/[ \n]/)[0]!.length }] }),
    ...(o.reply && {
      reply_to_message: { message_id: 2, date: 1, chat: chat(o.chat ?? CHAT), from: { id: o.reply.fromId, is_bot: true, first_name: "B" }, text: o.reply.text },
    }),
  },
});
const tap = (data: string, o: { chat?: string; messageId?: number; noMessage?: boolean; text?: string } = {}) => ({
  update_id: updateId++,
  callback_query: {
    id: "cb1",
    from,
    chat_instance: "ci",
    data,
    ...(!o.noMessage && { message: { message_id: o.messageId ?? 50, date: 1, chat: chat(o.chat ?? CHAT), text: o.text ?? OLD } }),
  },
});
const prompt = (paymentId: number) => ({ text: `Name for the new student (payment #${paymentId}):`, fromId: 999 });

const methods = () => calls.map((c) => c.method);
const dump = () => fake.raw.all("SELECT (SELECT COUNT(*) FROM students) s, (SELECT COUNT(*) FROM payer_emails) e, (SELECT group_concat(status) FROM payments) p");
async function seedPayment(over = {}, session = "cs_1", product: Product | null = null) {
  const p = await store.recordPayment(payment(over, session), null, product);
  await store.markNotified(p.id, 50);
  return p.id;
}
const edited = () => calls.find((c) => c.method === "editMessageText");
const logged = () => [...log.mock.calls, ...error.mock.calls].flat();

describe("secret and routing", () => {
  test.each([["missing", null], ["wrong", "nope"], ["prefix", "tg_secre"]])("%s secret -> 401, nothing happens", async (_n, secret) => {
    const id = await seedPayment();
    const before = dump();
    const res = await post(tap(`p:${id}:x`), { secret });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(makeBot).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(dump()).toEqual(before);
  });

  test("GET -> 405 allow POST", async () => {
    const res = await worker().fetch(new Request("https://worker.test/telegram/webhook"), env());
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  test("config is checked before the secret", async () => {
    const res = await post({}, { secret: "wrong", e: env({ DB: undefined }) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "misconfigured" });
  });
});

describe("other chats", () => {
  test.each([
    ["command", () => message("/students", { chat: "-5" })],
    ["callback", () => tap("p:1:x", { chat: "-5" })],
    ["reply", () => message("Marie", { chat: "-5", reply: prompt(1) })],
    ["callback without message", () => tap("p:1:x", { noMessage: true })],
  ])("%s is ignored", async (_n, build) => {
    const id = await seedPayment();
    const before = dump();
    const update = build();
    const res = await post(update);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(calls).toHaveLength(0);
    expect(dump()).toEqual(before);
    expect(log.mock.calls).toEqual([["telegram update from other chat ignored:", update.update_id]]);
    expect(id).toBe(1);
  });

  test("a plain message in the chat is silent", async () => {
    const res = await post(message("hello"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(calls).toHaveLength(0);
    expect(logged()).toHaveLength(0);
  });
});

describe("picking a student", () => {
  test("tap assigns, saves the email and edits the message", async () => {
    const id = await seedPayment();
    const ira = addStudent(fake, "Ira + Pasha");
    let rowWhenAnswered: unknown;
    respond = (method) => {
      if (method === "answerCallbackQuery") rowWhenAnswered = fake.raw.all("SELECT status FROM payments");
      return { ok: true, result: true };
    };
    const res = await post(tap(`p:${id}:s:${ira}`));
    expect(res.status).toBe(200);
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(rowWhenAnswered).toEqual([{ status: "assigned" }]);
    expect(edited()?.payload).toMatchObject({
      chat_id: Number(CHAT),
      message_id: 50,
      text: `💶 Ira + Pasha paid 160,00\u00a0€\nanna@example.com saved as Ira + Pasha's email\n${LINK}`,
      link_preview_options: { is_disabled: true },
    });
    expect(edited()?.payload.reply_markup).toBeUndefined();
    expect(fake.raw.all("SELECT email, student_id FROM payer_emails")).toEqual([{ email: "anna@example.com", student_id: ira }]);
  });

  test("a later payment from that email is announced by name", async () => {
    const id = await seedPayment();
    const ira = addStudent(fake, "Ira + Pasha");
    await post(tap(`p:${id}:s:${ira}`));
    const matched = await store.findStudentByEmail("anna@example.com");
    expect(matched?.name).toBe("Ira + Pasha");
  });

  test("no email -> no second line", async () => {
    const id = await seedPayment({ customerEmail: null });
    const ira = addStudent(fake, "Ira");
    await post(tap(`p:${id}:s:${ira}`));
    expect(edited()?.payload.text).toBe(`💶 Ira paid 160,00\u00a0€\n${LINK}`);
  });

  test("email already theirs -> no second line", async () => {
    const id = await seedPayment();
    const ira = addStudent(fake, "Ira", { emails: ["anna@example.com"] });
    await post(tap(`p:${id}:s:${ira}`));
    expect(edited()?.payload.text).toBe(`💶 Ira paid 160,00\u00a0€\n${LINK}`);
  });

  test("email owned by another student stays with the owner", async () => {
    const id = await seedPayment();
    const olena = addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const ira = addStudent(fake, "Ira + Pasha");
    await post(tap(`p:${id}:s:${ira}`));
    expect(edited()?.payload.text).toBe(`💶 Ira + Pasha paid 160,00\u00a0€\nanna@example.com already belongs to Olena\n${LINK}`);
    expect(fake.raw.all("SELECT student_id FROM payer_emails")).toEqual([{ student_id: olena }]);
    expect(fake.raw.all("SELECT student_id FROM payments")).toEqual([{ student_id: ira }]);
  });
});

describe("cancel", () => {
  test("dismisses and edits", async () => {
    const id = await seedPayment();
    await post(tap(`p:${id}:x`));
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({
      text: `💶 Payment dismissed: 160,00\u00a0€\nAnna K <anna@example.com>\n${LINK}`,
      link_preview_options: { is_disabled: true },
    });
    expect(fake.raw.all("SELECT status FROM payments")).toEqual([{ status: "dismissed" }]);
    expect(dump()[0]?.e).toBe(0);
  });
});

describe("stale and unknown taps", () => {
  test("a second Cancel is answered Already handled", async () => {
    const id = await seedPayment();
    await post(tap(`p:${id}:x`));
    calls.length = 0;
    const res = await post(tap(`p:${id}:x`));
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Already handled" } });
    expect(edited()?.payload.text).toBe(`💶 Payment dismissed: 160,00\u00a0€\nAnna K <anna@example.com>\n${LINK}`);
    expect(logged().filter((a) => String(a).includes("failed"))).toHaveLength(0);
  });

  test("an assigned payment shows the resolved text without the second line and saves nothing", async () => {
    const id = await seedPayment();
    const ira = addStudent(fake, "Ira");
    const olena = addStudent(fake, "Olena");
    await post(tap(`p:${id}:s:${ira}`));
    calls.length = 0;
    await post(tap(`p:${id}:s:${olena}`));
    expect(calls[0]?.payload.text).toBe("Already handled");
    expect(edited()?.payload).toMatchObject({ text: `💶 Ira paid 160,00\u00a0€\n${LINK}`, link_preview_options: { is_disabled: true } });
    expect(fake.raw.all("SELECT student_id FROM payments")).toEqual([{ student_id: ira }]);
    expect(dump()[0]?.e).toBe(1);
  });

  test("New student on a resolved payment is Already handled", async () => {
    const id = await seedPayment();
    await post(tap(`p:${id}:x`));
    calls.length = 0;
    await post(tap(`p:${id}:new`));
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload.text).toBe("Already handled");
  });

  test("message is not modified and a failing answer are tolerated", async () => {
    const id = await seedPayment();
    await post(tap(`p:${id}:x`));
    respond = (method) =>
      method === "editMessageText"
        ? { ok: false, error_code: 400, description: "Bad Request: message is not modified" }
        : { ok: false, error_code: 400, description: "query is too old" };
    calls.length = 0;
    const res = await post(tap(`p:${id}:x`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(error).not.toHaveBeenCalled();
  });

  test.each([
    ["unknown payment", () => "p:99:x"],
    ["unknown student", () => "p:1:s:99"],
    ["unparsable data", () => "garbage"],
    ["unknown payment for new", () => "p:99:new"],
  ])("%s -> Not found", async (_n, data) => {
    await seedPayment();
    const before = dump();
    const res = await post(tap(data()));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
    expect(dump()).toEqual(before);
  });
});

describe("new student", () => {
  test("tap asks for a name with force_reply", async () => {
    const id = await seedPayment();
    await post(tap(`p:${id}:new`));
    expect(methods()).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(calls[1]?.payload).toMatchObject({
      chat_id: CHAT,
      text: `Name for the new student (payment #${id}):`,
      reply_markup: { force_reply: true },
    });
  });

  test("the reply creates the student and edits the announcement", async () => {
    const id = await seedPayment();
    const res = await post(message("  Marie   Curie ", { reply: prompt(id) }));
    expect(res.status).toBe(200);
    expect(fake.raw.all("SELECT name, name_key FROM students")).toEqual([{ name: "Marie Curie", name_key: "marie curie" }]);
    expect(fake.raw.all("SELECT status FROM payments")).toEqual([{ status: "assigned" }]);
    expect(dump()[0]?.e).toBe(1);
    expect(methods()).toEqual(["editMessageText", "sendMessage"]);
    expect(edited()?.payload).toMatchObject({
      chat_id: CHAT,
      message_id: 50,
      text: `💶 Marie Curie paid 160,00\u00a0€\nanna@example.com saved as Marie Curie's email\n${LINK}`,
      link_preview_options: { is_disabled: true },
    });
    expect(calls[1]?.payload.text).toBe("Added Marie Curie.");
  });

  test("sending the same name again says already handled", async () => {
    const id = await seedPayment();
    await post(message("Marie Curie", { reply: prompt(id) }));
    calls.length = 0;
    await post(message("Marie Curie", { reply: prompt(id) }));
    expect(calls.map((c) => c.payload.text)).toEqual([`Payment #${id} is already handled.`]);
    expect(dump()[0]?.s).toBe(1);
  });

  test.each([
    ["empty name", (_id: number) => "   ", "Name must be 1-64 characters."],
    ["long name", (_id: number) => "x".repeat(65), "Name must be 1-64 characters."],
  ])("%s", async (_n, name, text) => {
    const id = await seedPayment();
    await post(message(name(id), { reply: prompt(id) }));
    expect(calls.map((c) => c.payload.text)).toEqual([text]);
    expect(dump()[0]?.s).toBe(0);
  });

  test("a missing payment", async () => {
    await post(message("Marie", { reply: prompt(42) }));
    expect(calls.map((c) => c.payload.text)).toEqual(["Payment #42 not found."]);
    expect(dump()[0]?.s).toBe(0);
  });

  test("a taken name, ignoring case", async () => {
    const id = await seedPayment();
    addStudent(fake, "Marie Curie");
    await post(message("marie curie", { reply: prompt(id) }));
    expect(calls.map((c) => c.payload.text)).toEqual(["A student named Marie Curie already exists. Pick them from the list."]);
    expect(dump()[0]?.s).toBe(1);
    expect(fake.raw.all("SELECT status FROM payments")).toEqual([{ status: "unassigned" }]);
  });

  test("an error check order: invalid name before missing payment", async () => {
    await post(message(" ", { reply: prompt(42) }));
    expect(calls.map((c) => c.payload.text)).toEqual(["Name must be 1-64 characters."]);
  });

  test.each([
    ["a reply to another message", () => message("Marie", { reply: { text: "hello", fromId: 999 } })],
    ["a reply to another sender", () => message("Marie", { reply: { text: "Name for the new student (payment #1):", fromId: 5 } })],
    ["not a reply", () => message("Marie")],
    ["a slash text", () => message("/Marie", { reply: { text: "Name for the new student (payment #1):", fromId: 999 } })],
  ])("%s is not a name", async (_n, build) => {
    await seedPayment();
    const res = await post(build());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(dump()[0]?.s).toBe(0);
  });
});

describe("/students", () => {
  test("lists active students in name order", async () => {
    addStudent(fake, "Olena");
    addStudent(fake, "Ira + Pasha");
    addStudent(fake, "ira + pasha 2");
    addStudent(fake, "Old One", { archived: true });
    await post(message("/students"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({ chat_id: Number(CHAT), text: "Students (3):\nIra + Pasha: 0\nira + pasha 2: 0\nOlena: 0" });
  });

  test("answers with the bot username suffix", async () => {
    addStudent(fake, "Olena");
    await post(message("/students@tutor_bot"));
    expect(calls[0]?.payload.text).toBe("Students (1):\nOlena: 0");
  });

  test("empty", async () => {
    await post(message("/students"));
    expect(calls[0]?.payload.text).toBe("No students yet.");
  });
});

describe("/help", () => {
  test.each(["/help", "/start", "/help@tutor_bot"])("%s replies with the command list", async (text) => {
    await post(message(text));
    expect(methods()).toEqual(["sendMessage"]);
    expect(calls[0]?.payload.text).toBe(helpText());
  });

  test("is ignored from another chat", async () => {
    await post(message("/help", { chat: "-100999" }));
    expect(calls).toEqual([]);
  });
});

describe("/rename", () => {
  const names = () => fake.raw.all("SELECT name FROM students ORDER BY id").map((r) => r.name);

  test("renames and sends nothing else", async () => {
    addStudent(fake, "Olena");
    await post(message("/rename olena -> Olena K"));
    expect(calls.map((c) => c.payload.text)).toEqual(["Renamed Olena to Olena K."]);
    expect(methods()).toEqual(["sendMessage"]);
    expect(names()).toEqual(["Olena K"]);
  });

  test("a case-only change succeeds", async () => {
    addStudent(fake, "Olena");
    await post(message("/rename olena -> OLENA"));
    expect(calls[0]?.payload.text).toBe("Renamed Olena to OLENA.");
    expect(names()).toEqual(["OLENA"]);
  });

  test("splits on the first arrow", async () => {
    addStudent(fake, "Olena");
    await post(message("/rename Olena -> A -> B"));
    expect(names()).toEqual(["A -> B"]);
  });

  test.each([
    ["no arrow", "/rename Olena", "Usage: /rename Old name -> New name"],
    ["no argument", "/rename", "Usage: /rename Old name -> New name"],
    ["empty old", "/rename -> X", "Usage: /rename Old name -> New name"],
    ["empty new", "/rename Olena ->  ", "Usage: /rename Old name -> New name"],
    ["unknown old", "/rename  nobody   here -> X", "No student named nobody here."],
    ["taken new", "/rename Olena -> ira", "A student named Ira already exists."],
    ["too long", `/rename Olena -> ${"x".repeat(65)}`, "Name must be 1-64 characters."],
  ])("%s", async (_n, text, reply) => {
    addStudent(fake, "Olena");
    addStudent(fake, "Ira");
    await post(message(text));
    expect(calls.map((c) => c.payload.text)).toEqual([reply]);
    expect(names()).toEqual(["Olena", "Ira"]);
  });
});

describe("error paths", () => {
  test.each([
    ["callback", async () => tap(`p:${await seedPayment()}:x`)],
    ["name reply", async () => message("Marie", { reply: prompt(await seedPayment()) })],
  ])("a D1 failure during a %s -> 200 ok, one safe log", async (_n, build) => {
    const update = await build();
    fake.failNext();
    const res = await post(update);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(error.mock.calls).toEqual([["telegram update failed:", "Error", update.update_id]]);
    for (const arg of logged()) {
      for (const text of [String(arg), JSON.stringify(arg)]) {
        for (const secret of ["Anna", "anna@example.com", "Marie", "777:tok", "p:1:x"]) expect(text).not.toContain(secret);
      }
    }
  });

  test("a non-JSON body with a valid secret -> 500 internal, body not logged", async () => {
    const res = await post(null, { body: "not json SENTINEL" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    for (const arg of logged()) expect(JSON.stringify(arg)).not.toContain("SENTINEL");
  });

  test("makeBot rejecting -> 500 internal", async () => {
    makeBot.mockRejectedValueOnce(new Error("getMe failed"));
    const res = await post(message("/students"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  test("a callback outlasting the webhook timeout -> 200 empty", async () => {
    vi.useFakeTimers();
    const id = await seedPayment();
    respond = (method) => (method === "answerCallbackQuery" ? new Promise((r) => setTimeout(() => r({ ok: true, result: true }), 30000)) : { ok: true, result: true });
    const pending = post(tap(`p:${id}:x`));
    await vi.advanceTimersByTimeAsync(9000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    await vi.advanceTimersByTimeAsync(30000);
  });
});

const T4 = "Індивідуальний пакет 4";
const CLUBN = "Клуб B2/C1 — поурочно";
const EUR = "160,00\u00a0€";
const pack = PRODUCTS_FIXTURE.plink_t4!;
const club = PRODUCTS_FIXTURE.plink_club!;
const keyboardOf = (pid: number) => ({
  inline_keyboard: [[{ text: "-1", callback_data: `p:${pid}:-1` }, { text: "+1", callback_data: `p:${pid}:+1` }]],
});
const balanceOf = async (name: string) => (await store.listStudentBalances()).find((b) => b.name === name)?.balance;
const adjustmentRows = () => fake.raw.all("SELECT student_id, delta, reason, payment_id FROM adjustments ORDER BY id");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function seedAssigned(name: string, balance: number, product: Product | null = pack) {
  const sid = addStudent(fake, name, { emails: ["olena@example.com"] });
  if (balance !== 0) addAdjustment(fake, sid, balance);
  const student = await store.findStudentByEmail("olena@example.com");
  const p = await store.recordPayment(payment({ customerEmail: "olena@example.com" }), student, product);
  await store.markNotified(p.id, 50);
  return { sid, pid: p.id };
}

describe("picking a student for a product", () => {
  test("a Pack is credited and the edit shows the Balance and the correction buttons", async () => {
    const id = await seedPayment({}, "cs_1", pack);
    const marta = addStudent(fake, "Marta");
    const res = await post(tap(`p:${id}:s:${marta}`));
    expect(res.status).toBe(200);
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({
      message_id: 50,
      text: `💶 Marta paid for 4 lessons (${T4}, ${EUR})\nanna@example.com saved as Marta's email\nBalance: 0 → 4\n${LINK}`,
      reply_markup: keyboardOf(id),
      link_preview_options: { is_disabled: true },
    });
    expect(await balanceOf("Marta")).toBe(4);
  });

  test("a name-only product is shown by name without buttons or Credit", async () => {
    const id = await seedPayment({}, "cs_1", club);
    const marta = addStudent(fake, "Marta");
    await post(tap(`p:${id}:s:${marta}`));
    expect(edited()?.payload.text).toBe(`💶 Marta paid ${EUR} for ${CLUBN}\nanna@example.com saved as Marta's email\n${LINK}`);
    expect(edited()?.payload.reply_markup).toBeUndefined();
    expect(await balanceOf("Marta")).toBe(0);
  });

  test("a Pack assigned to a Student archived after the picker was sent unarchives them", async () => {
    const id = await seedPayment({}, "cs_1", pack);
    const marta = addStudent(fake, "Marta", { archived: true });
    await post(tap(`p:${id}:s:${marta}`));
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({
      text: `💶 Marta paid for 4 lessons (${T4}, ${EUR})\nanna@example.com saved as Marta's email\nMarta was archived and is active again.\nBalance: 0 → 4\n${LINK}`,
      reply_markup: keyboardOf(id),
    });
    expect((await store.listActiveStudents()).map((s) => s.name)).toEqual(["Marta"]);
    expect(await balanceOf("Marta")).toBe(4);
    calls.length = 0;
    await post(tap(`p:${id}:s:${marta}`));
    expect(calls[0]?.payload.text).toBe("Already handled");
    expect(edited()?.payload.text).toBe(`💶 Marta paid for 4 lessons (${T4}, ${EUR})\nBalance: 0 → 4\n${LINK}`);
  });

  test("a name-only product leaves an archived Student archived", async () => {
    const id = await seedPayment({}, "cs_1", club);
    const marta = addStudent(fake, "Marta", { archived: true });
    await post(tap(`p:${id}:s:${marta}`));
    expect(edited()?.payload.text).toBe(`💶 Marta paid ${EUR} for ${CLUBN}\nanna@example.com saved as Marta's email\n${LINK}`);
    expect(edited()?.payload.reply_markup).toBeUndefined();
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${marta}`)).toEqual([{ archived: 1 }]);
  });

  test("a Student archived between the pre-read and the batch gets the unarchive line", async () => {
    const id = await seedPayment({}, "cs_1", pack);
    const marta = addStudent(fake, "Marta");
    fake.beforeNextBatch(() => fake.raw.run("UPDATE students SET archived = 1 WHERE id = ?1", marta));
    await post(tap(`p:${id}:s:${marta}`));
    expect(String(edited()?.payload.text)).toContain("Marta was archived and is active again.");
  });

  test("a Student unarchived between the pre-read and the batch gets no unarchive line", async () => {
    const id = await seedPayment({}, "cs_1", pack);
    const marta = addStudent(fake, "Marta", { archived: true });
    fake.beforeNextBatch(() => fake.raw.run("UPDATE students SET archived = 0 WHERE id = ?1", marta));
    await post(tap(`p:${id}:s:${marta}`));
    expect(String(edited()?.payload.text)).not.toContain("active again");
  });
});

describe("new student with a Pack", () => {
  test("the announcement shows the Balance and the buttons", async () => {
    const id = await seedPayment({}, "cs_1", pack);
    await post(message("Marie Curie", { reply: prompt(id) }));
    expect(edited()?.payload).toMatchObject({
      message_id: 50,
      text: `💶 Marie Curie paid for 4 lessons (${T4}, ${EUR})\nanna@example.com saved as Marie Curie's email\nBalance: 0 → 4\n${LINK}`,
      reply_markup: keyboardOf(id),
    });
    expect(calls.at(-1)?.payload.text).toBe("Added Marie Curie.");
    expect(await balanceOf("Marie Curie")).toBe(4);
  });
});

describe("dismissed and stale Pack messages", () => {
  test("Cancel names the product and credits nothing", async () => {
    const id = await seedPayment({}, "cs_1", pack);
    await post(tap(`p:${id}:x`));
    expect(edited()?.payload.text).toBe(`💶 Payment dismissed: ${EUR} for ${T4}\nAnna K <anna@example.com>\n${LINK}`);
    expect(edited()?.payload.reply_markup).toBeUndefined();
  });

  test("a stale picker tap on an assigned Pack re-renders the ledger Balance", async () => {
    const id = await seedPayment({}, "cs_1", pack);
    const marta = addStudent(fake, "Marta");
    await post(tap(`p:${id}:s:${marta}`));
    calls.length = 0;
    await post(tap(`p:${id}:s:${marta}`));
    expect(calls[0]?.payload.text).toBe("Already handled");
    expect(edited()?.payload.text).toBe(`💶 Marta paid for 4 lessons (${T4}, ${EUR})\nBalance: 0 → 4\n${LINK}`);
    expect(edited()?.payload.reply_markup).toEqual(keyboardOf(id));
    expect(await balanceOf("Marta")).toBe(4);
  });

  test("a stale picker tap on an assigned name-only payment shows no Balance", async () => {
    const id = await seedPayment({}, "cs_1", club);
    const marta = addStudent(fake, "Marta");
    await post(tap(`p:${id}:s:${marta}`));
    calls.length = 0;
    await post(tap(`p:${id}:s:${marta}`));
    expect(calls[0]?.payload.text).toBe("Already handled");
    expect(edited()?.payload.text).toBe(`💶 Marta paid ${EUR} for ${CLUBN}\n${LINK}`);
    expect(edited()?.payload.reply_markup).toBeUndefined();
    expect(await balanceOf("Marta")).toBe(0);
  });
});

describe("-1 / +1 taps", () => {
  test("+1 records a correction, answers after the write and edits with the ledger numbers", async () => {
    const { sid, pid } = await seedAssigned("Olena", 1);
    let rowsWhenAnswered: unknown;
    respond = (method) => {
      if (method === "answerCallbackQuery") rowsWhenAnswered = adjustmentRows();
      return { ok: true, result: true };
    };
    const res = await post(tap(`p:${pid}:+1`));
    expect(res.status).toBe(200);
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({
      message_id: 50,
      text: `💶 Olena paid for 4 lessons (${T4}, ${EUR})\nCorrection: +1\nBalance: 1 → 6\n${LINK}`,
      reply_markup: keyboardOf(pid),
      link_preview_options: { is_disabled: true },
    });
    const expected = { student_id: sid, delta: 1, reason: "payment correction", payment_id: pid };
    expect(adjustmentRows()).toContainEqual(expected);
    expect(rowsWhenAnswered).toContainEqual(expected);
    expect(fake.raw.all("SELECT created_at FROM adjustments WHERE payment_id IS NOT NULL")[0]?.created_at).toMatch(ISO);
  });

  test("-1 after +1 nets to zero and drops the Correction line, another -1 shows it", async () => {
    const { pid } = await seedAssigned("Olena", 1);
    await post(tap(`p:${pid}:+1`));
    calls.length = 0;
    await post(tap(`p:${pid}:-1`));
    expect(edited()?.payload.text).toBe(`💶 Olena paid for 4 lessons (${T4}, ${EUR})\nBalance: 1 → 5\n${LINK}`);
    expect(fake.raw.all("SELECT COUNT(*) AS n FROM adjustments WHERE payment_id IS NOT NULL")).toEqual([{ n: 2 }]);
    calls.length = 0;
    await post(tap(`p:${pid}:-1`));
    expect(edited()?.payload.text).toBe(`💶 Olena paid for 4 lessons (${T4}, ${EUR})\nCorrection: -1\nBalance: 1 → 4\n${LINK}`);
  });

  test("a failing answer does not stop the write or the edit", async () => {
    const { pid } = await seedAssigned("Olena", 1);
    respond = (method) =>
      method === "answerCallbackQuery" ? { ok: false, error_code: 400, description: "query is too old" } : { ok: true, result: true };
    const res = await post(tap(`p:${pid}:+1`));
    expect(res.status).toBe(200);
    expect(fake.raw.all("SELECT COUNT(*) AS n FROM adjustments WHERE payment_id IS NOT NULL")).toEqual([{ n: 1 }]);
    expect(edited()?.payload.text).toBe(`💶 Olena paid for 4 lessons (${T4}, ${EUR})\nCorrection: +1\nBalance: 1 → 6\n${LINK}`);
  });

  test("the numbers come from the ledger, not from the tapped message", async () => {
    const { sid, pid } = await seedAssigned("Olena", 1);
    addAdjustment(fake, sid, -2);
    await post(tap(`p:${pid}:+1`, { text: "💶 Olena paid for 4 lessons\nBalance: 100 → 200" }));
    expect(edited()?.payload.text).toBe(`💶 Olena paid for 4 lessons (${T4}, ${EUR})\nCorrection: +1\nBalance: -1 → 4\n${LINK}`);
  });

  test("a tap on an archived Student's Payment never unarchives them", async () => {
    const { sid, pid } = await seedAssigned("Olena", 1);
    fake.raw.run("UPDATE students SET archived = 1");
    await post(tap(`p:${pid}:+1`));
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({
      text: `💶 Olena paid for 4 lessons (${T4}, ${EUR})\nCorrection: +1\nBalance: 1 → 6\n${LINK}`,
      reply_markup: keyboardOf(pid),
    });
    expect(adjustmentRows()).toContainEqual({ student_id: sid, delta: 1, reason: "payment correction", payment_id: pid });
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${sid}`)).toEqual([{ archived: 1 }]);
  });

  test("a payment that unarchived the Student shows no unarchive line on later taps", async () => {
    addStudent(fake, "Old One", { emails: ["old@example.com"], archived: true });
    const student = await store.findStudentByEmail("old@example.com");
    const recorded = await store.recordPayment(payment({ customerEmail: "old@example.com" }), student, pack);
    await store.markNotified(recorded.id, 50);
    expect(recorded.unarchived).toBe(true);
    await post(tap(`p:${recorded.id}:+1`));
    expect(edited()?.payload.text).toBe(`💶 Old One paid for 4 lessons (${T4}, ${EUR})\nCorrection: +1\nBalance: 0 → 5\n${LINK}`);
  });

  describe("that cannot apply", () => {
    const expectNotFound = () => {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
      expect(adjustmentRows()).toEqual([]);
    };

    test("a payment that never existed", async () => {
      await post(tap("p:99:+1"));
      expectNotFound();
    });

    test("an unassigned Pack", async () => {
      const id = await seedPayment({}, "cs_1", pack);
      await post(tap(`p:${id}:+1`));
      expectNotFound();
    });

    test("a dismissed Pack", async () => {
      const id = await seedPayment({}, "cs_1", pack);
      await store.dismissPayment(id);
      await post(tap(`p:${id}:-1`));
      expectNotFound();
    });

    test("an assigned name-only payment", async () => {
      const { pid } = await seedAssigned("Olena", 0, club);
      await post(tap(`p:${pid}:+1`));
      expectNotFound();
    });

    test.each([["p:1:+2"], ["p:1:+"]])("data %s", async (data) => {
      await seedAssigned("Olena", 0);
      await post(tap(data));
      expectNotFound();
    });
  });
});

describe("/adjust", () => {
  const seed = () => {
    const olena = addStudent(fake, "Olena");
    const ira = addStudent(fake, "Ira + Pasha");
    return { olena, ira };
  };
  const reply = () => calls.map((c) => c.payload.text);

  test.each([
    ["/adjust Olena +5 opening balance", "olena", 5, "opening balance", "Olena: +5 (opening balance). Balance: 0 → 5"],
    ["/adjust olena 5 opening   balance", "olena", 5, "opening balance", "Olena: +5 (opening balance). Balance: 0 → 5"],
    ["/adjust Ira + Pasha -1 missed lesson", "ira", -1, "missed lesson", "Ira + Pasha: -1 (missed lesson). Balance: 0 → -1"],
    ["/adjust olena +0005 x", "olena", 5, "x", "Olena: +5 (x). Balance: 0 → 5"],
    ["/adjust Olena -1 -", "olena", -1, "-", "Olena: -1 (-). Balance: 0 → -1"],
    ["/adjust@tutor_bot Olena -1 x", "olena", -1, "x", "Olena: -1 (x). Balance: 0 → -1"],
    ["/adjust Olena +99 x", "olena", 99, "x", "Olena: +99 (x). Balance: 0 → 99"],
  ])("%s", async (text, who, delta, reason, replyText) => {
    const ids = seed();
    await post(message(text));
    expect(reply()).toEqual([replyText]);
    expect(adjustmentRows()).toEqual([{ student_id: ids[who as "olena" | "ira"], delta, reason, payment_id: null }]);
    expect(fake.raw.all("SELECT created_at FROM adjustments")[0]?.created_at).toMatch(ISO);
  });

  test("the longer of two overlapping names wins (number inside the name)", async () => {
    addStudent(fake, "Ira + Pasha");
    const second = addStudent(fake, "ira + pasha 2");
    await post(message("/adjust ira + pasha 2 -1 x"));
    expect(reply()).toEqual(["ira + pasha 2: -1 (x). Balance: 0 → -1"]);
    expect(adjustmentRows()).toEqual([{ student_id: second, delta: -1, reason: "x", payment_id: null }]);
  });

  test("Group 2 beats Group", async () => {
    addStudent(fake, "Group");
    const two = addStudent(fake, "Group 2");
    await post(message("/adjust Group 2 3 club makeup"));
    expect(adjustmentRows()).toEqual([{ student_id: two, delta: 3, reason: "club makeup", payment_id: null }]);
  });

  test("an archived Student is unarchived and the reply says so", async () => {
    const oldOne = addStudent(fake, "Old One", { archived: true });
    await post(message("/adjust Old One +2 back from break"));
    expect(reply()).toEqual(["Old One: +2 (back from break). Balance: 0 → 2\nOld One was archived and is active again."]);
    expect((await store.listActiveStudents()).map((s) => s.id)).toEqual([oldOne]);
    calls.length = 0;
    await post(message("/adjust Old One +1 x"));
    expect(reply()).toEqual(["Old One: +1 (x). Balance: 2 → 3"]);
  });

  test.each([
    ["/adjust"],
    ["/adjust Olena"],
  ])("%s -> usage", async (text) => {
    seed();
    await post(message(text));
    expect(reply()).toEqual(["Usage: /adjust Name +5 [reason]"]);
    expect(adjustmentRows()).toEqual([]);
  });

  test("missing reason defaults to '-'", async () => {
    seed();
    await post(message("/adjust Olena +5"));
    expect(reply()).toEqual(["Olena: +5 (-). Balance: 0 → 5"]);
    expect(adjustmentRows().map((r) => r.reason)).toEqual(["-"]);
  });

  test("more than 10 candidates -> usage before any lookup", async () => {
    seed();
    fake.failNext("first");
    await post(message("/adjust a 1 2 3 4 5 6 7 8 9 10 11 x"));
    expect(reply()).toEqual(["Usage: /adjust Name +5 [reason]"]);
    expect(error.mock.calls.flat().some((a) => String(a).includes("telegram update failed:"))).toBe(false);
    await expect(store.findStudentByNameKey("olena")).rejects.toThrow("d1 fake: injected failure");
    expect(adjustmentRows()).toEqual([]);
  });

  test("10 candidates reach 10 lookups", async () => {
    seed();
    const prepare = vi.spyOn(fake, "prepare");
    await post(message("/adjust a 1 2 3 4 5 6 7 8 9 10 x"));
    expect(reply()).toEqual(["No student named a."]);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("name_key = ?1"))).toHaveLength(10);
  });

  test("10 candidates adjust a Student named a, right to left", async () => {
    const a = addStudent(fake, "a");
    await post(message("/adjust a 1 2 3 4 5 6 7 8 9 10 x"));
    expect(adjustmentRows()).toEqual([{ student_id: a, delta: 1, reason: "2 3 4 5 6 7 8 9 10 x", payment_id: null }]);
  });

  test.each([
    ["/adjust Nobody +1 x", "No student named Nobody."],
    ["/adjust Nobody 0 x", "No student named Nobody."],
    ["/adjust Olna -1 lesson on 12 may", "No student named Olna."],
    ["/adjust Olena 0 x", "Count must be 1-99."],
    ["/adjust Olena +100 x", "Count must be 1-99."],
    [`/adjust Olena 0 ${"y".repeat(201)}`, "Count must be 1-99."],
    [`/adjust Olena +1 ${"y".repeat(201)}`, "Reason must be 1-200 characters."],
    [`/adjust Olena +1 ${"😀".repeat(201)}`, "Reason must be 1-200 characters."],
  ])("%s -> error, nothing written", async (text, expected) => {
    seed();
    await post(message(text));
    expect(reply()).toEqual([expected]);
    expect(adjustmentRows()).toEqual([]);
  });

  test("a reason of exactly 200 astral characters is accepted", async () => {
    const { olena } = seed();
    const reason = "😀".repeat(200);
    await post(message(`/adjust Olena +1 ${reason}`));
    expect(adjustmentRows()).toEqual([{ student_id: olena, delta: 1, reason, payment_id: null }]);
  });
});

describe("/students with Balances", () => {
  test("shows each active Student's Balance", async () => {
    const olena = addStudent(fake, "Olena");
    addStudent(fake, "Ira + Pasha");
    const second = addStudent(fake, "ira + pasha 2");
    addStudent(fake, "Old One", { archived: true });
    addAdjustment(fake, olena, 5);
    addAdjustment(fake, second, -1);
    await post(message("/students@tutor_bot"));
    expect(calls[0]?.payload.text).toBe("Students (3):\nIra + Pasha: 0\nira + pasha 2: -1\nOlena: 5");
  });
});

const CARD_TEXT = (name: string, balance: number, emails: string, telegram: string, archived = false, names = " none") =>
  `👤 ${name}${archived ? " (archived)" : ""}\nBalance: ${balance}\nEmails: ${emails}\nTelegram: ${telegram}\nCalendar names:${names}`;
const OLENA_EMAILS = "o2@example.com, olena@example.com";
const buttonRow = (...b: [string, string][]) => b.map(([text, callback_data]) => ({ text, callback_data }));
const titleRow = (sid: number, archived: boolean, names: boolean): [string, string][][] => {
  const row: [string, string][] = [
    ...(archived ? [] : ([["\u2795 Calendar name", `s:${sid}:title+`]] as [string, string][])),
    ...(names ? ([["\u2796 Calendar name", `s:${sid}:title-`]] as [string, string][]) : []),
  ];
  return row.length === 0 ? [] : [row];
};
const cardKeyboard = (sid: number, archived: boolean, minus: boolean, names = false) => ({
  inline_keyboard: [
    buttonRow(["-1", `s:${sid}:-1`], ["+1", `s:${sid}:+1`]),
    buttonRow(["✏️ Rename", `s:${sid}:name`], ["👤 Username", `s:${sid}:user`]),
    buttonRow(["➕ Email", `s:${sid}:email+`], ...(minus ? ([["➖ Email", `s:${sid}:email-`]] as [string, string][]) : [])),
    ...titleRow(sid, archived, names).map((r) => buttonRow(...r)),
    buttonRow(archived ? ["📤 Unarchive", `s:${sid}:unarchive`] : ["🗄 Archive", `s:${sid}:archive`]),
  ],
});
const ACTIVE = (sid: number, minus: boolean, names = false) => cardKeyboard(sid, false, minus, names);
const ARCHIVED = (sid: number, minus: boolean, names = false) => cardKeyboard(sid, true, minus, names);
const CARD = { messageId: 60 };

function seedCards() {
  const olena = addStudent(fake, "Olena", { emails: ["olena@example.com", "o2@example.com"] });
  fake.raw.run("UPDATE students SET telegram_username = 'olena_k' WHERE id = ?1", olena);
  addAdjustment(fake, olena, 5);
  const ira = addStudent(fake, "Ira + Pasha", { emails: ["ira@example.com"] });
  const ira2 = addStudent(fake, "ira + pasha 2");
  addAdjustment(fake, ira2, -1);
  const old = addStudent(fake, "Old One", { archived: true });
  return { olena, ira, ira2, old };
}
const olenaCard = (balance = 5, telegram = "@olena_k", name = "Olena", emails = OLENA_EMAILS) => CARD_TEXT(name, balance, emails, telegram);
const noCalls = () => expect(calls).toHaveLength(0);
const onlyNotFound = () => {
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
};
const sent = () => calls.filter((c) => c.method === "sendMessage");
const lastSent = () => sent().at(-1)?.payload;
const NOPREVIEW = { link_preview_options: { is_disabled: true } };

describe("student lists", () => {
  test("/students has one button per Student", async () => {
    const { olena, ira, ira2 } = seedCards();
    await post(message("/students"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      text: "Students (3):\nIra + Pasha: 0\nira + pasha 2: -1\nOlena: 5",
      reply_markup: {
        inline_keyboard: [
          buttonRow(["Ira + Pasha", `s:${ira}:open`], ["ira + pasha 2", `s:${ira2}:open`]),
          buttonRow(["Olena", `s:${olena}:open`]),
        ],
      },
      ...NOPREVIEW,
    });
  });

  test("no Students -> no keyboard", async () => {
    await post(message("/students"));
    expect(calls[0]?.payload.text).toBe("No students yet.");
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
  });

  test.each(["/archived", "/archived@tutor_bot"])("%s lists Archived Students with buttons", async (text) => {
    const { old } = seedCards();
    await post(message(text));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      text: "Archived students (1):\nOld One: 0",
      reply_markup: { inline_keyboard: [buttonRow(["Old One", `s:${old}:open`])] },
      ...NOPREVIEW,
    });
  });

  test("/archived with none", async () => {
    addStudent(fake, "Olena");
    await post(message("/archived"));
    expect(calls[0]?.payload.text).toBe("No archived students.");
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
  });
});

describe("opening the card", () => {
  test("an active card is sent as a new message", async () => {
    const { olena } = seedCards();
    const before = dump();
    await post(tap(`s:${olena}:open`, CARD));
    expect(methods()).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(calls[1]?.payload).toMatchObject({ chat_id: CHAT, text: olenaCard(), reply_markup: ACTIVE(olena, true), ...NOPREVIEW });
    expect(calls[1]?.payload.entities).toBeUndefined();
    expect(dump()).toEqual(before);
  });

  test("an archived card shows its state", async () => {
    const { old } = seedCards();
    await post(tap(`s:${old}:open`, CARD));
    expect(calls[1]?.payload).toMatchObject({
      text: "👤 Old One (archived)\nBalance: 0\nEmails: none\nTelegram: not set\nCalendar names: none",
      reply_markup: ARCHIVED(old, false),
    });
  });

  test("an unknown Student is Not found", async () => {
    seedCards();
    await post(tap("s:999:open", CARD));
    onlyNotFound();
  });

  test("unparsable card data is Not found and writes nothing", async () => {
    seedCards();
    const before = dump();
    await post(tap("s:1:bogus", CARD));
    onlyNotFound();
    expect(dump()).toEqual(before);
  });
});

describe("card -1 / +1", () => {
  test("edits in place and records reason '-'", async () => {
    const { olena } = seedCards();
    let rowsWhenAnswered: unknown;
    respond = (method) => {
      if (method === "answerCallbackQuery") rowsWhenAnswered = fake.raw.all("SELECT student_id, delta, reason, payment_id, created_at FROM adjustments WHERE reason = '-'");
      return { ok: true, result: true };
    };
    await post(tap(`s:${olena}:-1`, { messageId: 60, text: "👤 Olena\nBalance: 100" }));
    expect(rowsWhenAnswered).toEqual([{ student_id: olena, delta: -1, reason: "-", payment_id: null, created_at: expect.stringMatching(ISO) }]);
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({ message_id: 60, text: olenaCard(4), reply_markup: ACTIVE(olena, true), ...NOPREVIEW });

    calls.length = 0;
    await post(tap(`s:${olena}:+1`, CARD));
    expect(edited()?.payload.text).toBe(olenaCard(5));
    expect(fake.raw.all("SELECT reason FROM adjustments WHERE student_id = ?1 AND reason = '-'".replace("?1", String(olena)))).toHaveLength(2);
  });

  test("on an Archived Student it unarchives, like /adjust", async () => {
    const { old } = seedCards();
    await post(tap(`s:${old}:+1`, CARD));
    expect(fake.raw.all(`SELECT student_id, delta, reason, payment_id FROM adjustments WHERE student_id = ${old}`)).toEqual([
      { student_id: old, delta: 1, reason: "-", payment_id: null },
    ]);
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${old}`)).toEqual([{ archived: 0 }]);
    expect(edited()?.payload).toMatchObject({
      text: `Old One was archived and is active again.\n${CARD_TEXT("Old One", 1, "none", "not set")}`,
      reply_markup: ACTIVE(old, false),
      ...NOPREVIEW,
    });

    calls.length = 0;
    await post(message("/students"));
    expect(String(calls[0]?.payload.text)).toContain("Old One: 1");

    calls.length = 0;
    await post(tap(`s:${old}:-1`, CARD));
    expect(edited()?.payload.text).toBe(CARD_TEXT("Old One", 0, "none", "not set"));
  });

  test("an unknown Student is Not found and writes nothing", async () => {
    seedCards();
    const before = fake.raw.all("SELECT * FROM adjustments");
    await post(tap("s:999:+1", CARD));
    onlyNotFound();
    expect(fake.raw.all("SELECT * FROM adjustments")).toEqual(before);
  });
});

describe("unknown Student on every card action", () => {
  test.each(["name", "user", "email+", "card", "email-", "rm:7007e771", "unarchive", "archive", "-1"])("s:999:%s", async (action) => {
    seedCards();
    const before = dump();
    await post(tap(`s:999:${action}`, CARD));
    onlyNotFound();
    expect(dump()).toEqual(before);
  });
});

describe("rename on the card", () => {
  test("the prompt, then the reply sends a fresh card", async () => {
    const { olena } = seedCards();
    await post(tap(`s:${olena}:name`, CARD));
    expect(methods()).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(calls[1]?.payload).toMatchObject({
      text: `New name for student #${olena} (Olena):`,
      reply_markup: { force_reply: true },
    });

    calls.length = 0;
    await post(message("  Olena   K ", { reply: { text: `New name for student #${olena} (Olena):`, fromId: 999 } }));
    expect(fake.raw.all(`SELECT name, name_key FROM students WHERE id = ${olena}`)).toEqual([{ name: "Olena K", name_key: "olena k" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      text: `✅ Renamed Olena to Olena K.\n${olenaCard(5, "@olena_k", "Olena K")}`,
      reply_markup: ACTIVE(olena, true),
      ...NOPREVIEW,
    });
  });

  test.each([
    ["too long", (_n: number) => "x".repeat(65), "Name must be 1-64 characters."],
    ["taken, ignoring case", (_n: number) => "IRA + PASHA", "A student named Ira + Pasha already exists."],
  ])("%s", async (_t, name, expected) => {
    const { olena } = seedCards();
    await post(message(name(olena), { reply: { text: `New name for student #${olena} (Olena):`, fromId: 999 } }));
    expect(calls.map((c) => c.payload.text)).toEqual([expected]);
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
    expect(fake.raw.all(`SELECT name FROM students WHERE id = ${olena}`)).toEqual([{ name: "Olena" }]);
  });

  test("an unknown Student", async () => {
    seedCards();
    await post(message("Ghost", { reply: { text: "New name for student #999 (Ghost):", fromId: 999 } }));
    expect(calls.map((c) => c.payload.text)).toEqual(["Student #999 not found."]);
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
  });
});

describe("add email on the card", () => {
  const askText = (sid: number, name = "Olena") => `Email to add for student #${sid} (${name}):`;
  const reply = (text: string, sid: number, name?: string) => message(text, { reply: { text: askText(sid, name), fromId: 999 } });

  test("the prompt", async () => {
    const { olena } = seedCards();
    await post(tap(`s:${olena}:email+`, CARD));
    expect(methods()).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(calls[1]?.payload).toMatchObject({ text: askText(olena), reply_markup: { force_reply: true } });
  });

  test("a new email is added and later payments match it", async () => {
    const { olena } = seedCards();
    await post(reply(" O3@Example.COM ", olena));
    expect(fake.raw.all("SELECT email, student_id FROM payer_emails WHERE email = 'o3@example.com'")).toEqual([{ email: "o3@example.com", student_id: olena }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: ACTIVE(olena, true),
      ...NOPREVIEW,
    });
    expect(String(calls[0]?.payload.text)).toBe(
      `✅ Added o3@example.com to Olena.\n${olenaCard(5, "@olena_k", "Olena", "o2@example.com, o3@example.com, olena@example.com")}`,
    );

    const send = vi.fn().mockResolvedValue({ messageId: 9 });
    await makeOnPaymentReceived({ notifier: { send }, store })(payment({ customerEmail: "o3@example.com" }, "cs_9"));
    expect(String(send.mock.calls[0]?.[0]).startsWith(`💶 Olena paid ${EUR}`)).toBe(true);
  });

  test("an email already theirs is noted, nothing changes", async () => {
    const { olena } = seedCards();
    await post(reply("o2@example.com", olena));
    expect(String(calls[0]?.payload.text).startsWith("o2@example.com is already Olena's email.\n👤 Olena")).toBe(true);
    expect(dump()[0]?.e).toBe(3);
  });

  test("another Student's email is refused and stays", async () => {
    const { olena, ira } = seedCards();
    await post(reply("IRA@example.com", olena));
    expect(calls.map((c) => c.payload.text)).toEqual(["ira@example.com already belongs to Ira + Pasha."]);
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
    expect(fake.raw.all("SELECT student_id FROM payer_emails WHERE email = 'ira@example.com'")).toEqual([{ student_id: ira }]);
  });

  test.each(["not-an-email", "a@b"])("%s is not an address", async (text) => {
    const { olena } = seedCards();
    const before = dump();
    await post(reply(text, olena));
    expect(calls.map((c) => c.payload.text)).toEqual(["That does not look like an email address."]);
    expect(dump()).toEqual(before);
  });

  test("an unknown Student", async () => {
    seedCards();
    const before = dump();
    await post(reply("x@example.com", 999, "Ghost"));
    expect(calls.map((c) => c.payload.text)).toEqual(["Student #999 not found."]);
    expect(dump()).toEqual(before);
  });
});

describe("email removal on the card", () => {
  test("the email keyboard and Back", async () => {
    const { olena, old } = seedCards();
    await post(tap(`s:${olena}:email-`, CARD));
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({
      message_id: 60,
      text: olenaCard(),
      reply_markup: {
        inline_keyboard: [
          buttonRow([`✖️ o2@example.com`, `s:${olena}:rm:e5bb3129`]),
          buttonRow([`✖️ olena@example.com`, `s:${olena}:rm:7007e771`]),
          buttonRow(["⬅️ Back", `s:${olena}:card`]),
        ],
      },
    });

    calls.length = 0;
    await post(tap(`s:${olena}:card`, CARD));
    expect(edited()?.payload).toMatchObject({ message_id: 60, text: olenaCard(), reply_markup: ACTIVE(olena, true) });

    calls.length = 0;
    await post(tap(`s:${old}:email-`, CARD));
    expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
    expect(edited()?.payload).toMatchObject({ reply_markup: ARCHIVED(old, false) });
  });

  test("removes one email, then the last one", async () => {
    const { olena, ira } = seedCards();
    await post(tap(`s:${olena}:rm:e5bb3129`, CARD));
    expect(fake.raw.all(`SELECT email FROM payer_emails WHERE student_id = ${olena}`)).toEqual([{ email: "olena@example.com" }]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({ text: olenaCard(5, "@olena_k", "Olena", "olena@example.com"), reply_markup: ACTIVE(olena, true) });

    calls.length = 0;
    const before = dump();
    await post(tap(`s:${olena}:rm:e5bb3129`, CARD));
    expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
    expect(edited()?.payload.text).toBe(olenaCard(5, "@olena_k", "Olena", "olena@example.com"));
    expect(dump()).toEqual(before);

    calls.length = 0;
    await post(tap(`s:${olena}:rm:7007e771`, CARD));
    expect(edited()?.payload).toMatchObject({ text: olenaCard(5, "@olena_k", "Olena", "none"), reply_markup: ACTIVE(olena, false) });

    calls.length = 0;
    await post(tap(`s:${olena}:rm:7fc48b74`, CARD));
    expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
    expect(fake.raw.all(`SELECT email FROM payer_emails WHERE student_id = ${ira}`)).toEqual([{ email: "ira@example.com" }]);
  });

  test("a tag collision never deletes", async () => {
    const lone = addStudent(fake, "Lone", { emails: ["u31992@example.com", "u605430@example.com"] });
    await post(tap(`s:${lone}:rm:120680e9`, CARD));
    expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
    expect(edited()?.payload.text).toBe(CARD_TEXT("Lone", 0, "u31992@example.com, u605430@example.com", "not set"));
    expect(fake.raw.all(`SELECT email FROM payer_emails WHERE student_id = ${lone}`)).toHaveLength(2);
  });

  test("an email moved to someone else after the card read is Already handled", async () => {
    const { olena, ira } = seedCards();
    let ran = 0;
    fake.beforeNextBatch(() => {
      ran += 1;
      fake.raw.run("UPDATE payer_emails SET student_id = ?1 WHERE email = 'o2@example.com'", ira);
    });
    await post(tap(`s:${olena}:rm:e5bb3129`, CARD));
    expect(ran).toBe(1);
    expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Already handled" } });
    expect(edited()?.payload).toMatchObject({
      text: olenaCard(5, "@olena_k", "Olena", "olena@example.com"),
      reply_markup: ACTIVE(olena, true),
    });
    expect(fake.raw.all("SELECT student_id FROM payer_emails WHERE email = 'o2@example.com'")).toEqual([{ student_id: ira }]);
  });
});

describe("username on the card", () => {
  const askText = (sid: number, name = "Olena") => `Telegram username for student #${sid} (${name}), or - to clear:`;
  const reply = (text: string, sid: number, name?: string) => message(text, { reply: { text: askText(sid, name), fromId: 999 } });
  const stored = (sid: number) => fake.raw.all(`SELECT telegram_username FROM students WHERE id = ${sid}`)[0]?.telegram_username;

  test("the prompt", async () => {
    const { olena } = seedCards();
    await post(tap(`s:${olena}:user`, CARD));
    expect(calls[1]?.payload).toMatchObject({ text: askText(olena), reply_markup: { force_reply: true } });
  });

  test.each([
    ["@Olena_K2", "Olena_K2", "✅ Saved @Olena_K2 for Olena.", "Telegram: @Olena_K2"],
    ["olena_k3", "olena_k3", "✅ Saved @olena_k3 for Olena.", "Telegram: @olena_k3"],
    ["abcd", "abcd", "✅ Saved @abcd for Olena.", "Telegram: @abcd"],
    ["-", null, "✅ Cleared Olena's Telegram username.", "Telegram: not set"],
  ])("%j is accepted", async (text, expectedStored, note, line) => {
    const { olena } = seedCards();
    await post(reply(text, olena));
    expect(stored(olena)).toBe(expectedStored);
    expect(calls).toHaveLength(1);
    const lines = String(calls[0]?.payload.text).split("\n");
    expect(lines[0]).toBe(note);
    expect(lines.at(-2)).toBe(line);
    expect(calls[0]?.payload.entities).toBeUndefined();
    expect(calls[0]?.payload).toMatchObject({ reply_markup: ACTIVE(olena, true), ...NOPREVIEW });
  });

  test.each(["abc", "1abcd", "has space", "@@olena_k", "a".repeat(33)])("%j is refused", async (text) => {
    const { olena } = seedCards();
    await post(reply(text, olena));
    expect(calls.map((c) => c.payload.text)).toEqual(["A username is 4-32 letters, digits or underscores, starting with a letter."]);
    expect(stored(olena)).toBe("olena_k");
  });

  test("an unknown Student", async () => {
    seedCards();
    await post(reply("olena_k", 999, "Ghost"));
    expect(calls.map((c) => c.payload.text)).toEqual(["Student #999 not found."]);
  });
});

describe("editing an Archived Student", () => {
  test("rename, username and email keep them archived", async () => {
    const { old } = seedCards();
    const ask = (kind: string, name: string, tail = ":") => ({ text: `${kind} student #${old} (${name})${tail}`, fromId: 999 });

    await post(message("Old Two", { reply: ask("New name for", "Old One") }));
    expect(fake.raw.all(`SELECT name, name_key, archived FROM students WHERE id = ${old}`)).toEqual([{ name: "Old Two", name_key: "old two", archived: 1 }]);
    expect(calls[0]?.payload).toMatchObject({
      text: `✅ Renamed Old One to Old Two.\n${CARD_TEXT("Old Two", 0, "none", "not set", true)}`,
      reply_markup: ARCHIVED(old, false),
    });

    calls.length = 0;
    await post(message("old_one", { reply: ask("Telegram username for", "Old Two", ", or - to clear:") }));
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${old}`)).toEqual([{ archived: 1 }]);
    expect(String(calls[0]?.payload.text).split("\n")[1]).toBe("👤 Old Two (archived)");

    calls.length = 0;
    await post(message("old@example.com", { reply: ask("Email to add for", "Old Two") }));
    expect(fake.raw.all("SELECT email, student_id FROM payer_emails WHERE email = 'old@example.com'")).toEqual([{ email: "old@example.com", student_id: old }]);
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${old}`)).toEqual([{ archived: 1 }]);
    expect(String(calls[0]?.payload.text).split("\n")[1]).toBe("👤 Old Two (archived)");
  });
});

describe("archive on the card", () => {
  test("archive, list changes, unarchive", async () => {
    const { olena } = seedCards();
    await post(tap(`s:${olena}:archive`, CARD));
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${olena}`)).toEqual([{ archived: 1 }]);
    expect(calls[0]?.payload.text).toBeUndefined();
    expect(edited()?.payload).toMatchObject({
      text: CARD_TEXT("Olena", 5, OLENA_EMAILS, "@olena_k", true),
      reply_markup: ARCHIVED(olena, true),
      ...NOPREVIEW,
    });

    calls.length = 0;
    await post(message("/students"));
    expect(String(calls[0]?.payload.text)).not.toContain("Olena");
    calls.length = 0;
    await post(message("/archived"));
    expect(String(calls[0]?.payload.text)).toContain("Olena: 5");

    const send = vi.fn().mockResolvedValue({ messageId: 9 });
    await makeOnPaymentReceived({ notifier: { send }, store })(payment({ customerEmail: "nobody@example.com" }, "cs_7"));
    const buttons = (send.mock.calls[0]?.[1] as { buttons: { text: string }[][] }).buttons.flat().map((b) => b.text);
    expect(buttons).not.toContain("Olena");

    calls.length = 0;
    await post(tap(`s:${olena}:unarchive`, CARD));
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${olena}`)).toEqual([{ archived: 0 }]);
    expect(edited()?.payload).toMatchObject({ reply_markup: ACTIVE(olena, true) });
  });

  test("a second archive is Already handled even when the edit is not modified", async () => {
    const { olena } = seedCards();
    await post(tap(`s:${olena}:archive`, CARD));
    respond = (method) => (method === "editMessageText" ? { ok: false, error_code: 400, description: "Bad Request: message is not modified" } : { ok: true, result: true });
    calls.length = 0;
    const before = dump();
    const res = await post(tap(`s:${olena}:archive`, CARD));
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Already handled" } });
    expect(dump()).toEqual(before);
    expect(error).not.toHaveBeenCalled();
  });

  test("an unknown Student", async () => {
    seedCards();
    await post(tap("s:999:archive", CARD));
    onlyNotFound();
  });
});

describe("prompt replies are bound to the bot and the contract", () => {
  test("a reply to a prompt sent by someone else changes nothing", async () => {
    const { olena } = seedCards();
    await post(message("Olena K", { reply: { text: `New name for student #${olena} (Olena):`, fromId: 5 } }));
    expect(fake.raw.all(`SELECT name FROM students WHERE id = ${olena}`)).toEqual([{ name: "Olena" }]);
    noCalls();
  });

  test("a command replied to a prompt is not an answer", async () => {
    const { olena } = seedCards();
    await post(message("/students", { reply: { text: `New name for student #${olena} (Olena):`, fromId: 999 } }));
    expect(fake.raw.all(`SELECT name FROM students WHERE id = ${olena}`)).toEqual([{ name: "Olena" }]);
    expect(calls.map((c) => String(c.payload.text).includes("Renamed"))).toEqual([false]);
  });

  test("a new-student prompt with a 17-digit id is ignored", async () => {
    await seedPayment();
    const before = dump();
    await post(message("Marie", { reply: { text: "Name for the new student (payment #12345678901234567):", fromId: 999 } }));
    noCalls();
    expect(dump()).toEqual(before);
  });
});

describe("Balance error paths", () => {
  const expectSafeFailure = async (update: { update_id: number }) => {
    const res = await post(update);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(error.mock.calls).toEqual([["telegram update failed:", "Error", update.update_id]]);
    for (const arg of logged()) {
      for (const text of [String(arg), JSON.stringify(arg)]) {
        for (const secret of ["olena@example.com", "Olena", "Old One", T4, "777:tok"]) expect(text).not.toContain(secret);
      }
    }
  };

  describe("Student card failures", () => {
    const expectNoLeak = () => {
      for (const arg of logged()) {
        for (const text of [String(arg), JSON.stringify(arg)]) {
          for (const secret of ["o2@example.com", "olena_k"]) expect(text).not.toContain(secret);
        }
      }
    };
    const emailsOf = () => fake.raw.all("SELECT email FROM payer_emails ORDER BY email").map((r) => r.email);
    const olenaRow = (id: number) => fake.raw.all(`SELECT name, archived, telegram_username FROM students WHERE id = ${id}`);

    test("opening a card when the read fails sends nothing", async () => {
      const { olena } = seedCards();
      fake.failNext("first");
      await expectSafeFailure(tap(`s:${olena}:open`, CARD));
      expect(calls).toHaveLength(0);
      expectNoLeak();
    });

    test("a -1 whose batch fails writes nothing", async () => {
      const { olena } = seedCards();
      const rowsBefore = adjustmentRows();
      fake.failNext("batch");
      await expectSafeFailure(tap(`s:${olena}:-1`, CARD));
      expect(calls).toHaveLength(0);
      expect(adjustmentRows()).toEqual(rowsBefore);
      expectNoLeak();
    });

    test("a +1 committed before the card read fails is accepted", async () => {
      const { olena } = seedCards();
      const rowsBefore = adjustmentRows().length;
      fake.failNext("first");
      await expectSafeFailure(tap(`s:${olena}:+1`, CARD));
      expect(calls).toHaveLength(0);
      expect(adjustmentRows()).toHaveLength(rowsBefore + 1);
      expectNoLeak();
    });

    test.each([
      ["email removal", (olena: number) => tap(`s:${olena}:rm:e5bb3129`, CARD)],
      ["archive", (olena: number) => tap(`s:${olena}:archive`, CARD)],
      ["rename reply", (olena: number) => message("Olena K", { reply: { text: `New name for student #${olena} (Olena):`, fromId: 999 } })],
      ["add email reply", (olena: number) => message("o3@example.com", { reply: { text: `Email to add for student #${olena} (Olena):`, fromId: 999 } })],
    ])("a failing %s batch changes nothing", async (_n, build) => {
      const { olena } = seedCards();
      const emailsBefore = emailsOf();
      fake.failNext("batch");
      await expectSafeFailure(build(olena));
      expect(calls).toHaveLength(0);
      expect(emailsOf()).toEqual(emailsBefore);
      expect(emailsOf()).toContain("o2@example.com");
      expect(emailsOf()).toContain("olena@example.com");
      expect(emailsOf()).not.toContain("o3@example.com");
      expect(olenaRow(olena)).toEqual([{ name: "Olena", archived: 0, telegram_username: "olena_k" }]);
      expectNoLeak();
    });

    test("a failing username write keeps the username", async () => {
      const { olena } = seedCards();
      fake.failNext("all");
      await expectSafeFailure(message("Olena_K2", { reply: { text: `Telegram username for student #${olena} (Olena), or - to clear:`, fromId: 999 } }));
      expect(calls).toHaveLength(0);
      expect(olenaRow(olena)).toEqual([{ name: "Olena", archived: 0, telegram_username: "olena_k" }]);
      expectNoLeak();
    });
  });

  test("a D1 failure on a -1 / +1 write", async () => {
    const { pid } = await seedAssigned("Olena", 0);
    fake.failNext("all");
    await expectSafeFailure(tap(`p:${pid}:+1`));
    expect(adjustmentRows()).toEqual([]);
  });

  test("a D1 failure on the /adjust name lookup", async () => {
    addStudent(fake, "Olena");
    fake.failNext("first");
    await expectSafeFailure(message("/adjust Olena +1 x"));
    expect(adjustmentRows()).toEqual([]);
  });

  test("a D1 failure on the /adjust write", async () => {
    addStudent(fake, "Olena");
    fake.failNext("batch");
    await expectSafeFailure(message("/adjust Olena +1 x"));
    expect(adjustmentRows()).toEqual([]);
  });

  test("a failed /adjust write leaves an archived Student archived", async () => {
    const oldOne = addStudent(fake, "Old One", { archived: true });
    fake.failNext("batch");
    await expectSafeFailure(message("/adjust Old One +1 x"));
    expect(adjustmentRows()).toEqual([]);
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${oldOne}`)).toEqual([{ archived: 1 }]);
  });
});

describe("/adjust races", () => {
  test("a Student unarchived by someone else after the lookup gets no unarchive line", async () => {
    const oldOne = addStudent(fake, "Old One", { archived: true });
    fake.beforeNextBatch(() => fake.raw.run("UPDATE students SET archived = 0 WHERE id = ?1", oldOne));
    await post(message("/adjust Old One +2 x"));
    expect(calls[0]?.payload.text).toBe("Old One: +2 (x). Balance: 0 → 2");
  });

  test("a Student archived after the lookup is unarchived and the reply says so", async () => {
    const olena = addStudent(fake, "Olena");
    fake.beforeNextBatch(() => fake.raw.run("UPDATE students SET archived = 1 WHERE id = ?1", olena));
    await post(message("/adjust Olena +2 x"));
    expect(String(calls[0]?.payload.text).endsWith("\nOlena was archived and is active again.")).toBe(true);
  });
});

describe("Calendar names on the card", () => {
  const DUO = "Duo B2/C1 (Mira K, Yeva)";
  const TAG_DUO = "28b125b6";
  const TAG_YEVA = "b1ad1d0a";
  const OK = "\u2705";
  const askText = (sid: number, name: string) => `Calendar name to add for student #${sid} (${name}):`;
  const reply = (text: string, sid: number, name: string) => message(text, { reply: { text: askText(sid, name), fromId: 999 } });
  const nameRows = () => fake.raw.all("SELECT title_key, student_id, title FROM calendar_names ORDER BY title_key, student_id");
  const ignoredRows = () => fake.raw.all("SELECT title_key FROM ignored_titles");
  const dumpAll = () => ({ names: nameRows(), ignored: ignoredRows(), students: fake.raw.all("SELECT id, archived FROM students") });
  const removalKeyboard = (sid: number, ...rows: [string, string][]) => ({
    inline_keyboard: [...rows.map((r) => buttonRow(r)), buttonRow(["\u2B05\uFE0F Back", `s:${sid}:card`])],
  });
  const injectOnce = (sql: string, ...params: (string | number)[]) => fake.runBeforeNextBatch(sql, ...params);
  const duoLine = (others: string) => `\u2022 ${DUO}${others === "" ? "" : `, shared with ${others}`}`;

  let marko: number;
  let miraK: number;
  let yeva: number;
  beforeEach(() => {
    marko = addStudent(fake, "Marko");
    miraK = addStudent(fake, "Mira K");
    yeva = addStudent(fake, "Yeva");
  });

  describe("adding", () => {
    test("the prompt is sent with force_reply", async () => {
      await post(tap(`s:${marko}:title+`, CARD));
      expect(methods()).toEqual(["answerCallbackQuery", "sendMessage"]);
      expect(calls[1]?.payload).toMatchObject({ chat_id: CHAT, text: askText(marko, "Marko"), reply_markup: { force_reply: true } });
    });

    test("a reply adds the name and sends a fresh card", async () => {
      await post(reply("Marko", marko, "Marko"));
      expect(nameRows()).toEqual([{ title_key: "marko", student_id: marko, title: "Marko" }]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.payload).toMatchObject({
        text: `${OK} Added calendar name Marko to Marko.\n${CARD_TEXT("Marko", 0, "none", "not set", false, "\n\u2022 Marko")}`,
        reply_markup: ACTIVE(marko, false, true),
        ...NOPREVIEW,
      });
    });

    test("a title attached to someone else says who shares it", async () => {
      addCalendarName(fake, miraK, DUO);
      await post(reply(DUO, yeva, "Yeva"));
      expect(String(calls[0]?.payload.text).split("\n")[0]).toBe(`${OK} Added calendar name ${DUO} to Yeva. Shared with Mira K.`);
      expect(String(calls[0]?.payload.text).split("\n").at(-1)).toBe(duoLine("Mira K"));
      expect(nameRows()).toHaveLength(2);
    });

    test("an Ignored title is attached and un-ignored with a note", async () => {
      addIgnoredTitle(fake, "Prep");
      await post(reply("Prep", marko, "Marko"));
      expect(String(calls[0]?.payload.text).split("\n")[0]).toBe(
        `${OK} Added calendar name Prep to Marko. It was marked Not a lesson; its events now count as Lessons.`,
      );
      expect(ignoredRows()).toEqual([]);
      expect(nameRows()).toEqual([{ title_key: "prep", student_id: marko, title: "Prep" }]);
    });

    test("a name already attached is noted and not duplicated", async () => {
      addCalendarName(fake, marko, "Marko");
      await post(reply("MARKO", marko, "Marko"));
      expect(String(calls[0]?.payload.text).split("\n")[0]).toBe("Marko is already Marko's calendar name.");
      expect(calls[0]?.payload.reply_markup).toBeDefined();
      expect(nameRows()).toHaveLength(1);
    });

    test("a Student archived after the prompt is refused without a card", async () => {
      fake.raw.run("UPDATE students SET archived = 1 WHERE id = ?1", marko);
      await post(reply("Marko", marko, "Marko"));
      expect(calls.map((c) => c.payload.text)).toEqual(["Marko is archived. Unarchive them first."]);
      expect(calls[0]?.payload.reply_markup).toBeUndefined();
      expect(nameRows()).toEqual([]);
    });

    test("an unknown Student", async () => {
      await post(reply("Marko", 999, "Ghost"));
      expect(calls.map((c) => c.payload.text)).toEqual(["Student #999 not found."]);
      expect(nameRows()).toEqual([]);
    });

    test.each([
      ["blank", "   "],
      ["101 code points", "x".repeat(101)],
      ["a leading cancel mark", "\u274C Marko"],
    ])("%s is refused", async (_n, text) => {
      await post(reply(text, marko, "Marko"));
      expect(calls.map((c) => c.payload.text)).toEqual([
        "A calendar name is 1-100 characters and cannot start with \u274C, contain (\u043F\u0456\u0434\u0440\u044F\u0434\u043D\u0438\u0446\u044F) or contain \" \u2014 \".",
      ]);
      expect(nameRows()).toEqual([]);
    });

    test("an archived card answers Archived and sends nothing", async () => {
      fake.raw.run("UPDATE students SET archived = 1 WHERE id = ?1", marko);
      await post(tap(`s:${marko}:title+`, CARD));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Archived" } });
    });

    test("an unknown Student is Not found", async () => {
      await post(tap("s:999:title+", CARD));
      onlyNotFound();
    });
  });

  describe("removing", () => {
    beforeEach(() => {
      addCalendarName(fake, yeva, "Yeva");
      addCalendarName(fake, yeva, DUO);
      addCalendarName(fake, miraK, DUO);
    });
    const yevaText = (names: string, archived = false) => CARD_TEXT("Yeva", 0, "none", "not set", archived, names);
    const both = `\n${duoLine("Mira K")}\n\u2022 Yeva`;

    test("the removal keyboard keeps the card text, Back restores the card", async () => {
      await post(tap(`s:${yeva}:title-`, CARD));
      expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
      expect(edited()?.payload).toMatchObject({
        text: yevaText(both),
        reply_markup: removalKeyboard(yeva, [`\u2716\uFE0F ${DUO}`, `s:${yeva}:rt:${TAG_DUO}`], ["\u2716\uFE0F Yeva", `s:${yeva}:rt:${TAG_YEVA}`]),
      });
      calls.length = 0;
      await post(tap(`s:${yeva}:card`, CARD));
      expect(edited()?.payload).toMatchObject({ text: yevaText(both), reply_markup: ACTIVE(yeva, false, true) });
    });

    test("removing one name leaves the other Student's row", async () => {
      await post(tap(`s:${yeva}:rt:${TAG_DUO}`, CARD));
      expect(nameRows().map((r) => [r.title, r.student_id])).toEqual([[DUO, miraK], ["Yeva", yeva]]);
      expect(edited()?.payload).toMatchObject({ text: yevaText("\n\u2022 Yeva"), reply_markup: ACTIVE(yeva, false, true) });
      expect(calls[0]?.payload.text).toBeUndefined();
    });

    test.each([["a second tap on the removed name", TAG_DUO], ["a tag matching no name", "00000000"]])("%s is Not found and edits the card", async (_n, tag) => {
      await post(tap(`s:${yeva}:rt:${TAG_DUO}`, CARD));
      calls.length = 0;
      await post(tap(`s:${yeva}:rt:${tag}`, CARD));
      expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
      expect(edited()?.payload).toMatchObject({ text: yevaText("\n\u2022 Yeva") });
      expect(nameRows()).toHaveLength(2);
    });

    test("a row deleted before the batch is Already handled", async () => {
      const runs = injectOnce("DELETE FROM calendar_names WHERE student_id = ?1 AND title_key = 'yeva'", yeva);
      await post(tap(`s:${yeva}:rt:${TAG_YEVA}`, CARD));
      expect(runs.n).toBe(1);
      expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Already handled" } });
      expect(edited()?.payload).toMatchObject({ text: yevaText(`\n${duoLine("Mira K")}`) });
    });

    test("a card with no names answers Not found and edits the card", async () => {
      await post(tap(`s:${marko}:title-`, CARD));
      expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Not found" } });
      expect(edited()?.payload).toMatchObject({ reply_markup: ACTIVE(marko, false, false) });
    });

    test("an archived Student's leftover name can be removed", async () => {
      fake.raw.run("DELETE FROM calendar_names WHERE student_id = ?1", yeva);
      fake.raw.run("UPDATE students SET archived = 1 WHERE id = ?1", yeva);
      addCalendarName(fake, yeva, "Yeva");
      await post(tap(`s:${yeva}:title-`, CARD));
      expect(edited()?.payload).toMatchObject({ reply_markup: removalKeyboard(yeva, ["\u2716\uFE0F Yeva", `s:${yeva}:rt:${TAG_YEVA}`]) });
      calls.length = 0;
      await post(tap(`s:${yeva}:rt:${TAG_YEVA}`, CARD));
      expect(nameRows().map((r) => r.student_id)).toEqual([miraK]);
      expect(edited()?.payload).toMatchObject({ text: yevaText(" none", true), reply_markup: ARCHIVED(yeva, false, false) });
    });

    test.each(["title-", "rt:0a1b2c3d", "archive!"])("s:999:%s is Not found and writes nothing", async (action) => {
      const before = dumpAll();
      await post(tap(`s:999:${action}`, CARD));
      onlyNotFound();
      expect(dumpAll()).toEqual(before);
    });
  });

  describe("archiving", () => {
    beforeEach(() => {
      addCalendarName(fake, yeva, "Yeva");
      addCalendarName(fake, yeva, DUO);
      addCalendarName(fake, miraK, DUO);
    });
    const archivedCard = (names = " none") => CARD_TEXT("Yeva", 0, "none", "not set", true, names);

    test("the tap asks first and writes nothing; Back restores the card", async () => {
      const before = dumpAll();
      await post(tap(`s:${yeva}:archive`, CARD));
      expect(calls[0]?.payload.text).toBeUndefined();
      expect(edited()?.payload).toMatchObject({
        text: `Archive Yeva? This detaches their calendar names: ${DUO}, Yeva. Unarchiving does not bring them back.`,
        reply_markup: {
          inline_keyboard: [buttonRow(["\u{1F5C4} Archive and detach", `s:${yeva}:archive!`]), buttonRow(["\u2B05\uFE0F Back", `s:${yeva}:card`])],
        },
      });
      expect(dumpAll()).toEqual(before);
      calls.length = 0;
      await post(tap(`s:${yeva}:card`, CARD));
      expect(edited()?.payload).toMatchObject({ reply_markup: ACTIVE(yeva, false, true) });
      expect(dumpAll()).toEqual(before);
    });

    test("the confirmation archives, detaches and notes the names", async () => {
      await post(tap(`s:${yeva}:archive!`, CARD));
      expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${yeva}`)).toEqual([{ archived: 1 }]);
      expect(nameRows().map((r) => r.student_id)).toEqual([miraK]);
      expect(calls[0]?.payload.text).toBeUndefined();
      expect(edited()?.payload).toMatchObject({
        text: `Detached calendar names: ${DUO}, Yeva.\n${archivedCard()}`,
        reply_markup: ARCHIVED(yeva, false, false),
      });
    });

    test("a name added after the confirmation was shown is detached too", async () => {
      await post(tap(`s:${yeva}:archive`, CARD));
      addCalendarName(fake, yeva, "Taras morning");
      calls.length = 0;
      await post(tap(`s:${yeva}:archive!`, CARD));
      expect(String(edited()?.payload.text).split("\n")[0]).toBe(`Detached calendar names: ${DUO}, Taras morning, Yeva.`);
      expect(nameRows().map((r) => r.student_id)).toEqual([miraK]);
    });

    test("a stale confirmation on an archived Student is Already handled", async () => {
      await post(tap(`s:${marko}:archive`, CARD));
      calls.length = 0;
      await post(tap(`s:${marko}:archive!`, CARD));
      expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Already handled" } });
      expect(edited()?.payload).toMatchObject({ text: CARD_TEXT("Marko", 0, "none", "not set", true), reply_markup: ARCHIVED(marko, false, false) });
    });

    test("archiving an archived Student repairs leftover rows with a note", async () => {
      const old = addStudent(fake, "Old One", { archived: true });
      addCalendarName(fake, old, "Taras morning");
      await post(tap(`s:${old}:archive`, CARD));
      expect(calls[0]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "Already handled" } });
      expect(String(edited()?.payload.text).split("\n")[0]).toBe("Detached calendar names: Taras morning.");
      expect(nameRows().map((r) => r.student_id)).toEqual([miraK, yeva, yeva]);
    });

    test("a Student with no names archives in one tap without a note", async () => {
      await post(tap(`s:${marko}:archive`, CARD));
      expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${marko}`)).toEqual([{ archived: 1 }]);
      expect(edited()?.payload.text).toBe(CARD_TEXT("Marko", 0, "none", "not set", true));
    });
  });

  test("/adjust unarchives without restoring names", async () => {
    addCalendarName(fake, yeva, "Yeva");
    await post(tap(`s:${yeva}:archive!`, CARD));
    calls.length = 0;
    await post(message("/adjust Yeva +1"));
    expect(fake.raw.all(`SELECT archived FROM students WHERE id = ${yeva}`)).toEqual([{ archived: 0 }]);
    expect((await store.getStudentCard(yeva))?.calendarNames).toEqual([]);
    expect([...(await store.getTitleSets()).attached.values()].flat()).not.toContain(yeva);
    expect(await store.addCalendarName(yeva, "Yeva")).toMatchObject({ kind: "added" });
  });
});
