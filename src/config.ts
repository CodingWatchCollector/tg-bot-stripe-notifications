export interface Env {
  STRIPE_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface Config {
  stripeWebhookSecret: string;
  telegramBotToken: string;
  telegramChatId: string;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; missing: string[] };

export function readConfig(env: Env): ConfigResult {
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim();
  if (stripeWebhookSecret && telegramBotToken && telegramChatId) {
    return { ok: true, config: { stripeWebhookSecret, telegramBotToken, telegramChatId } };
  }
  const missing: string[] = [];
  if (!stripeWebhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!telegramChatId) missing.push("TELEGRAM_CHAT_ID");
  return { ok: false, missing };
}
