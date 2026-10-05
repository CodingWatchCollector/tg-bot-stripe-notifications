import { BotError, type Bot, webhookCallback } from "grammy";
import { errName, json } from "./respond";

export interface TelegramWebhookDeps {
  secret: string;
  makeBot: () => Promise<Bot>;
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function handleTelegramWebhook(request: Request, deps: TelegramWebhookDeps): Promise<Response> {
  const given = request.headers.get("x-telegram-bot-api-secret-token");
  if (given === null || !safeEqual(given, deps.secret)) return json(401, { error: "unauthorized" });

  const bot = await deps.makeBot();
  try {
    return await webhookCallback(bot, "cloudflare-mod", "return", 9000, deps.secret)(request);
  } catch (err) {
    if (err instanceof BotError) {
      console.error("telegram update failed:", errName(err.error), err.ctx.update.update_id);
      return json(200, { ok: true });
    }
    throw err;
  }
}
