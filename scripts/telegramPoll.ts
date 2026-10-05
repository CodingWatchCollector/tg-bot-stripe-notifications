export interface PollOptions {
  token: string;
  secret: string;
  target: string;
  fetch: typeof fetch;
  log: (line: string) => void;
}

export interface PollerDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  iterations?: number;
}

const DEFAULT_TARGET = "http://localhost:8787/telegram/webhook";

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

export async function pollOnce(opts: PollOptions, offset: number): Promise<number> {
  const query = new URLSearchParams({
    offset: String(offset),
    timeout: "25",
    allowed_updates: JSON.stringify(["message", "callback_query"]),
  });
  const res = await opts.fetch(`https://api.telegram.org/bot${opts.token}/getUpdates?${query}`);
  if (res.status !== 200) throw Object.assign(new Error("getUpdates failed"), { status: res.status });
  const body = (await res.json()) as { result: { update_id: number }[] };

  let next = offset;
  for (const update of body.result) {
    try {
      const forwarded = await opts.fetch(opts.target, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": opts.secret, "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      opts.log(`forwarded ${update.update_id} -> ${forwarded.status}`);
    } catch (err) {
      opts.log(`forward failed ${update.update_id}: ${errName(err)}`);
      return update.update_id;
    }
    next = update.update_id + 1;
  }
  return next;
}

export async function runPoller(deps: PollerDeps): Promise<number> {
  const token = deps.env.TELEGRAM_BOT_TOKEN;
  const secret = deps.env.TELEGRAM_WEBHOOK_SECRET;
  for (const [name, value] of [["TELEGRAM_BOT_TOKEN", token], ["TELEGRAM_WEBHOOK_SECRET", secret]] as const) {
    if (!value) {
      deps.log(`missing ${name} in .dev.vars`);
      return 1;
    }
  }
  const opts: PollOptions = {
    token: token as string,
    secret: secret as string,
    target: deps.env.DEV_WORKER_URL || DEFAULT_TARGET,
    fetch: deps.fetch,
    log: deps.log,
  };

  let offset = 0;
  for (let i = 0; i < (deps.iterations ?? Infinity); i++) {
    try {
      offset = await pollOnce(opts, offset);
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      if (status === 409) {
        deps.log("getUpdates conflict: the bot has a webhook set (use a separate test bot) or another poller is running");
        return 1;
      }
      if (status === 401 || status === 404) {
        deps.log("getUpdates rejected the token");
        return 1;
      }
      deps.log(`getUpdates failed: ${typeof status === "number" ? status : errName(err)}`);
      await deps.sleep(2000);
    }
  }
  return 0;
}
