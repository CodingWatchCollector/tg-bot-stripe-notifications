import { describe, expect, test, vi } from "vitest";
import { pollOnce, runPoller, type PollOptions } from "../scripts/telegramPoll";

const TOKEN = "777:token";
const TARGET = "http://localhost:8787/telegram/webhook";

const updatesResponse = (ids: number[], status = 200) =>
  new Response(JSON.stringify({ ok: status === 200, result: ids.map((update_id) => ({ update_id, message: { text: `m${update_id}` } })) }), { status });

function setup(handlers: { getUpdates?: () => Response | Promise<Response>; forward?: (body: string) => Response | Promise<Response> } = {}) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.hostname === "api.telegram.org") return (handlers.getUpdates ?? (() => updatesResponse([])))();
    return (handlers.forward ?? (() => new Response("", { status: 200 })))(String(init?.body));
  });
  const log = vi.fn();
  const opts: PollOptions = { token: TOKEN, secret: "sec", target: TARGET, fetch: fetchStub as unknown as typeof fetch, log };
  return { opts, requests, log, fetchStub };
}

describe("pollOnce", () => {
  test("requests getUpdates and forwards each update in order", async () => {
    const { opts, requests, log } = setup({ getUpdates: () => updatesResponse([7, 8]) });
    const next = await pollOnce(opts, 7);
    expect(next).toBe(9);
    const first = requests[0]!;
    expect(first.url.origin + first.url.pathname).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(first.init?.method ?? "GET").toBe("GET");
    expect(first.url.searchParams.get("offset")).toBe("7");
    expect(first.url.searchParams.get("timeout")).toBe("25");
    expect(JSON.parse(first.url.searchParams.get("allowed_updates")!)).toEqual(["message", "callback_query"]);
    const posts = requests.slice(1);
    expect(posts.map((r) => r.url.href)).toEqual([TARGET, TARGET]);
    expect(posts.map((r) => JSON.parse(String(r.init?.body)).update_id)).toEqual([7, 8]);
    for (const r of posts) {
      expect(r.init?.method).toBe("POST");
      expect(new Headers(r.init?.headers).get("x-telegram-bot-api-secret-token")).toBe("sec");
      expect(new Headers(r.init?.headers).get("content-type")).toBe("application/json");
    }
    expect(log.mock.calls).toEqual([["forwarded 7 -> 200"], ["forwarded 8 -> 200"]]);
  });

  test("an offset advances even when the local Worker answers 500", async () => {
    const { opts, log } = setup({ getUpdates: () => updatesResponse([7, 8]), forward: () => new Response("", { status: 500 }) });
    expect(await pollOnce(opts, 7)).toBe(9);
    expect(log).toHaveBeenCalledWith("forwarded 8 -> 500");
  });

  test("no updates keeps the offset", async () => {
    const { opts, requests } = setup();
    expect(await pollOnce(opts, 7)).toBe(7);
    expect(requests).toHaveLength(1);
  });

  test("a failed forward stops at that update", async () => {
    let n = 0;
    const { opts, log } = setup({
      getUpdates: () => updatesResponse([7, 8, 9]),
      forward: () => {
        if (++n === 2) throw new TypeError("fetch failed");
        return new Response("", { status: 200 });
      },
    });
    expect(await pollOnce(opts, 7)).toBe(8);
    expect(log.mock.calls).toEqual([["forwarded 7 -> 200"], ["forward failed 8: TypeError"]]);
  });

  test("a non-200 getUpdates throws with its status and forwards nothing", async () => {
    const { opts, requests } = setup({ getUpdates: () => updatesResponse([7], 409) });
    await expect(pollOnce(opts, 7)).rejects.toMatchObject({ status: 409 });
    expect(requests).toHaveLength(1);
  });
});

describe("runPoller", () => {
  const deps = (s: ReturnType<typeof setup>, env: Record<string, string | undefined>, extra = {}) => ({
    env,
    fetch: s.fetchStub as unknown as typeof fetch,
    sleep: vi.fn(async () => {}),
    log: s.log,
    ...extra,
  });
  const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "sec" };

  test.each([
    ["TELEGRAM_BOT_TOKEN", { TELEGRAM_WEBHOOK_SECRET: "sec" }],
    ["TELEGRAM_WEBHOOK_SECRET", { TELEGRAM_BOT_TOKEN: TOKEN }],
  ])("missing %s -> exit 1 without fetch", async (name, env) => {
    const s = setup();
    expect(await runPoller(deps(s, env))).toBe(1);
    expect(s.log).toHaveBeenCalledWith(`missing ${name} in .dev.vars`);
    expect(s.fetchStub).not.toHaveBeenCalled();
  });

  test("409 -> conflict message and exit 1", async () => {
    const s = setup({ getUpdates: () => updatesResponse([], 409) });
    expect(await runPoller(deps(s, ENV))).toBe(1);
    expect(s.log).toHaveBeenCalledWith(
      "getUpdates conflict: the bot has a webhook set (use a separate test bot) or another poller is running",
    );
  });

  test.each([401, 404])("%i -> token rejected and exit 1", async (status) => {
    const s = setup({ getUpdates: () => updatesResponse([], status) });
    expect(await runPoller(deps(s, ENV))).toBe(1);
    expect(s.log).toHaveBeenCalledWith("getUpdates rejected the token");
  });

  test("other failures sleep 2000 and retry with the same offset", async () => {
    let n = 0;
    const s = setup({
      getUpdates: () => {
        n++;
        if (n === 1) throw new TypeError("network");
        if (n === 2) return updatesResponse([], 502);
        return updatesResponse([]);
      },
    });
    const d = deps(s, ENV, { iterations: 3 });
    expect(await runPoller(d)).toBe(0);
    expect(s.log.mock.calls).toEqual([["getUpdates failed: TypeError"], ["getUpdates failed: 502"]]);
    expect(d.sleep.mock.calls).toEqual([[2000], [2000]]);
    expect(s.requests.map((r) => r.url.searchParams.get("offset"))).toEqual(["0", "0", "0"]);
  });

  test("each poll uses the offset the previous one returned", async () => {
    let n = 0;
    const s = setup({ getUpdates: () => (++n === 1 ? updatesResponse([7, 8]) : updatesResponse([])) });
    await runPoller(deps(s, ENV, { iterations: 2 }));
    const offsets = s.requests.filter((r) => r.url.hostname === "api.telegram.org").map((r) => r.url.searchParams.get("offset"));
    expect(offsets).toEqual(["0", "9"]);
  });

  test("target defaults to localhost and DEV_WORKER_URL overrides it", async () => {
    const a = setup({ getUpdates: () => updatesResponse([1]) });
    await runPoller(deps(a, ENV, { iterations: 1 }));
    expect(a.requests[1]?.url.href).toBe(TARGET);
    const b = setup({ getUpdates: () => updatesResponse([1]) });
    await runPoller(deps(b, { ...ENV, DEV_WORKER_URL: "http://localhost:9999/x" }, { iterations: 1 }));
    expect(b.requests[1]?.url.href).toBe("http://localhost:9999/x");
  });

  test("never logs the token or the secret", async () => {
    const s = setup({ getUpdates: () => updatesResponse([], 409) });
    await runPoller(deps(s, ENV));
    expect(JSON.stringify(s.log.mock.calls)).not.toContain(TOKEN);
  });
});
