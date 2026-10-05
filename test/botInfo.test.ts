import { Api } from "grammy";
import { describe, expect, test } from "vitest";
import { getBotInfo } from "../src/bot/botInfo";

const me = { id: 1, is_bot: true, first_name: "B", username: "b_bot" };

function stub(respond: () => unknown) {
  let calls = 0;
  const api = new Api("1:t");
  api.config.use(async () => {
    calls++;
    return respond() as never;
  });
  return { api, calls: () => calls };
}

describe("getBotInfo", () => {
  test("a resolved getMe is cached per token", async () => {
    const { api, calls } = stub(() => ({ ok: true, result: me }));
    expect(await getBotInfo("cache-a:t", api)).toMatchObject({ username: "b_bot" });
    await getBotInfo("cache-a:t", api);
    expect(calls()).toBe(1);
  });

  test("a rejection caches nothing", async () => {
    let fail = true;
    const { api, calls } = stub(() => (fail ? { ok: false, error_code: 500, description: "x" } : { ok: true, result: me }));
    await expect(getBotInfo("cache-b:t", api)).rejects.toThrow();
    fail = false;
    expect(await getBotInfo("cache-b:t", api)).toMatchObject({ username: "b_bot" });
    expect(calls()).toBe(2);
  });
});
