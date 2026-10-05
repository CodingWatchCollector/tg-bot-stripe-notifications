import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { createBot } from "../src/bot/bot";
import { createStore, type Store } from "../src/db/store";
import { createWorker } from "../src/worker";
import { createD1Fake, type D1Fake } from "./support/d1";
import { addStudent, payment } from "./support/seed";

const CHAT = "-100777";
const SECRET = "tg_secret";
const BOT = { id: 999, is_bot: true, first_name: "Tutor", username: "tutor_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as never;
const LINK = "https://dashboard.stripe.com/payments/pi_123";
const OLD = `💶 Unknown payer paid 160.00 EUR\nAnna K <anna@example.com>\nWho is this?\n${LINK}`;

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
const tap = (data: string, o: { chat?: string; messageId?: number; noMessage?: boolean } = {}) => ({
  update_id: updateId++,
  callback_query: {
    id: "cb1",
    from,
    chat_instance: "ci",
    data,
    ...(!o.noMessage && { message: { message_id: o.messageId ?? 50, date: 1, chat: chat(o.chat ?? CHAT), text: OLD } }),
  },
});
const prompt = (paymentId: number) => ({ text: `Name for the new student (payment #${paymentId}):`, fromId: 999 });

const methods = () => calls.map((c) => c.method);
const dump = () => fake.raw.all("SELECT (SELECT COUNT(*) FROM students) s, (SELECT COUNT(*) FROM payer_emails) e, (SELECT group_concat(status) FROM payments) p");
async function seedPayment(over = {}, session = "cs_1") {
  const p = await store.recordPayment(payment(over, session), null);
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
      text: `💶 Ira + Pasha paid 160.00 EUR\nanna@example.com saved as Ira + Pasha's email\n${LINK}`,
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
    expect(edited()?.payload.text).toBe(`💶 Ira paid 160.00 EUR\n${LINK}`);
  });

  test("email already theirs -> no second line", async () => {
    const id = await seedPayment();
    const ira = addStudent(fake, "Ira", { emails: ["anna@example.com"] });
    await post(tap(`p:${id}:s:${ira}`));
    expect(edited()?.payload.text).toBe(`💶 Ira paid 160.00 EUR\n${LINK}`);
  });

  test("email owned by another student stays with the owner", async () => {
    const id = await seedPayment();
    const olena = addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const ira = addStudent(fake, "Ira + Pasha");
    await post(tap(`p:${id}:s:${ira}`));
    expect(edited()?.payload.text).toBe(`💶 Ira + Pasha paid 160.00 EUR\nanna@example.com already belongs to Olena\n${LINK}`);
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
      text: `💶 Payment dismissed: 160.00 EUR\nAnna K <anna@example.com>\n${LINK}`,
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
    expect(edited()?.payload.text).toBe(`💶 Payment dismissed: 160.00 EUR\nAnna K <anna@example.com>\n${LINK}`);
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
    expect(edited()?.payload).toMatchObject({ text: `💶 Ira paid 160.00 EUR\n${LINK}`, link_preview_options: { is_disabled: true } });
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
      text: `💶 Marie Curie paid 160.00 EUR\nanna@example.com saved as Marie Curie's email\n${LINK}`,
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
    expect(calls[0]?.payload).toMatchObject({ chat_id: Number(CHAT), text: "Students (3):\nIra + Pasha\nira + pasha 2\nOlena" });
  });

  test("answers with the bot username suffix", async () => {
    addStudent(fake, "Olena");
    await post(message("/students@tutor_bot"));
    expect(calls[0]?.payload.text).toBe("Students (1):\nOlena");
  });

  test("empty", async () => {
    await post(message("/students"));
    expect(calls[0]?.payload.text).toBe("No students yet.");
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
