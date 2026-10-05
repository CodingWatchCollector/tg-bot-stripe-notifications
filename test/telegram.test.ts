import { Api } from "grammy";
import { describe, expect, test } from "vitest";
import { NotifyError } from "../src/notify/notifier";
import { createTelegramApi, createTelegramNotifier } from "../src/notify/telegram";

type Call = { method: string; payload: unknown };

function stubApi(respond: () => unknown) {
  const calls: Call[] = [];
  const api = new Api("123:abc");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return respond() as never;
  });
  return { api, calls };
}

describe("createTelegramNotifier", () => {
  test("sends plain text with link previews disabled", async () => {
    const { api, calls } = stubApi(() => ({ ok: true, result: { message_id: 1 } }));
    await createTelegramNotifier({ token: "123:abc", chatId: "42", api }).send("hello");
    expect(calls).toEqual([
      {
        method: "sendMessage",
        payload: { chat_id: "42", text: "hello", link_preview_options: { is_disabled: true } },
      },
    ]);
  });

  test("returns the message id", async () => {
    const { api } = stubApi(() => ({ ok: true, result: { message_id: 77 } }));
    expect(await createTelegramNotifier({ token: "123:abc", chatId: "42", api }).send("hello")).toEqual({ messageId: 77 });
  });

  test("maps buttons to an inline keyboard", async () => {
    const { api, calls } = stubApi(() => ({ ok: true, result: { message_id: 1 } }));
    await createTelegramNotifier({ token: "123:abc", chatId: "42", api }).send("pick", {
      buttons: [[{ text: "A", data: "p:1:new" }], [{ text: "B", data: "p:1:x" }, { text: "C", data: "p:1:s:2" }]],
    });
    expect(calls[0]?.payload).toEqual({
      chat_id: "42",
      text: "pick",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: "A", callback_data: "p:1:new" }],
          [
            { text: "B", callback_data: "p:1:x" },
            { text: "C", callback_data: "p:1:s:2" },
          ],
        ],
      },
    });
  });

  test("Telegram error becomes a NotifyError without the token", async () => {
    const { api } = stubApi(() => ({ ok: false, error_code: 403, description: "Forbidden" }));
    const err = await createTelegramNotifier({ token: "123:abc", chatId: "42", api })
      .send("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotifyError);
    const e = err as NotifyError;
    expect(e.name).toBe("NotifyError");
    expect(e.safeDetail).toBe("telegram 403: Forbidden");
    expect(e.message).toBe(e.safeDetail);
    for (const key of Reflect.ownKeys(e)) {
      expect(String((e as unknown as Record<PropertyKey, unknown>)[key])).not.toContain("123:abc");
    }
    expect(JSON.stringify(e)).not.toContain("123:abc");
    expect(e.stack ?? "").not.toContain("123:abc");
  });

  test("transport failure becomes a generic NotifyError", async () => {
    const { api } = stubApi(() => {
      throw new Error("fetch failed: https://api.telegram.org/bot123:abc/sendMessage");
    });
    const err = await createTelegramNotifier({ token: "123:abc", chatId: "42", api })
      .send("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotifyError);
    expect((err as NotifyError).safeDetail).toBe("telegram network error");
    expect(JSON.stringify(err)).not.toContain("123:abc");
    expect((err as NotifyError).message).not.toContain("123:abc");
    expect((err as NotifyError).cause).toBeUndefined();
  });
});

describe("createTelegramApi", () => {
  test("uses an 8 second timeout", () => {
    expect(createTelegramApi("123:abc").options?.timeoutSeconds).toBe(8);
  });
});
