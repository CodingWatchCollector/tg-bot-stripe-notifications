import { COMMANDS } from "../src/app/commands.ts";

export interface SetCommandsDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: (line: string) => void;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

// Registers the command menu for the configured chat only. Logs never include the token (it is in the request URL).
export async function runSetCommands(deps: SetCommandsDeps): Promise<number> {
  const token = deps.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = deps.env.TELEGRAM_CHAT_ID?.trim();
  for (const [name, value] of [["TELEGRAM_BOT_TOKEN", token], ["TELEGRAM_CHAT_ID", chatId]] as const) {
    if (!value) {
      deps.log(`missing ${name}`);
      return 1;
    }
  }

  const commands = COMMANDS.map(({ command, description }) => ({ command, description }));
  let res: Response;
  try {
    res = await deps.fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands, scope: { type: "chat", chat_id: chatId } }),
    });
  } catch (err) {
    deps.log(`setMyCommands failed: ${errName(err)}`);
    return 1;
  }

  const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (res.status !== 200 || body?.ok !== true) {
    deps.log(`setMyCommands failed: ${res.status} ${body?.description ?? ""}`.trim());
    return 1;
  }
  deps.log(`registered ${commands.length} commands for chat ${chatId}: ${commands.map((c) => `/${c.command}`).join(" ")}`);
  return 0;
}
