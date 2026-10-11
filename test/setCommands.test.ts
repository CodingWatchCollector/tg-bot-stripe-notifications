import { describe, expect, test, vi } from "vitest";
import { COMMANDS } from "../src/app/commands";
import { runSetCommands } from "../scripts/setCommands";

const TOKEN = "777:token";
const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100777" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(respond: () => Response | Promise<Response> = () => json({ ok: true, result: true })) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return respond();
  });
  const log = vi.fn();
  return { requests, log, fetch: fetchStub as unknown as typeof fetch };
}

describe("runSetCommands", () => {
  test("registers the menu for the configured chat", async () => {
    const { requests, log, fetch } = setup();
    expect(await runSetCommands({ env, fetch, log })).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/setMyCommands`);
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      commands: COMMANDS.map(({ command, description }) => ({ command, description })),
      scope: { type: "chat", chat_id: "-100777" },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("/students");
  });

  test.each(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"])("missing %s sends nothing", async (name) => {
    const { requests, log, fetch } = setup();
    expect(await runSetCommands({ env: { ...env, [name]: "  " }, fetch, log })).toBe(1);
    expect(requests).toEqual([]);
    expect(log).toHaveBeenCalledWith(`missing ${name}`);
  });

  test("a Telegram error is reported without the token", async () => {
    const { log, fetch } = setup(() => json({ ok: false, error_code: 401, description: "Unauthorized" }, 401));
    expect(await runSetCommands({ env, fetch, log })).toBe(1);
    expect(log).toHaveBeenCalledWith("setMyCommands failed: 401 Unauthorized");
  });

  test("a transport failure logs only the error name", async () => {
    const { log, fetch } = setup(() => {
      throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/setMyCommands`);
    });
    expect(await runSetCommands({ env, fetch, log })).toBe(1);
    expect(log).toHaveBeenCalledWith("setMyCommands failed: TypeError");
    for (const [line] of log.mock.calls) expect(String(line)).not.toContain(TOKEN);
  });
});
