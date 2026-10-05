export interface Env {
  STRIPE_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DB?: D1Database;
}

export interface StripeConfig {
  stripeWebhookSecret: string;
  telegramBotToken: string;
  telegramChatId: string;
  db: D1Database;
}

export interface TelegramConfig {
  telegramBotToken: string;
  telegramChatId: string;
  telegramWebhookSecret: string;
  db: D1Database;
}

export type ConfigResult<T> = { ok: true; config: T } | { ok: false; missing: string[] };

const text = (v: string | undefined): string | undefined => v?.trim() || undefined;

export function readStripeConfig(env: Env): ConfigResult<StripeConfig> {
  const stripeWebhookSecret = text(env.STRIPE_WEBHOOK_SECRET);
  const telegramBotToken = text(env.TELEGRAM_BOT_TOKEN);
  const telegramChatId = text(env.TELEGRAM_CHAT_ID);
  const db = env.DB;
  if (stripeWebhookSecret && telegramBotToken && telegramChatId && db) {
    return { ok: true, config: { stripeWebhookSecret, telegramBotToken, telegramChatId, db } };
  }
  const missing: string[] = [];
  if (!stripeWebhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!telegramChatId) missing.push("TELEGRAM_CHAT_ID");
  if (!db) missing.push("DB");
  return { ok: false, missing };
}

export function readTelegramConfig(env: Env): ConfigResult<TelegramConfig> {
  const telegramBotToken = text(env.TELEGRAM_BOT_TOKEN);
  const telegramChatId = text(env.TELEGRAM_CHAT_ID);
  const telegramWebhookSecret = text(env.TELEGRAM_WEBHOOK_SECRET);
  const db = env.DB;
  if (telegramBotToken && telegramChatId && telegramWebhookSecret && db) {
    return { ok: true, config: { telegramBotToken, telegramChatId, telegramWebhookSecret, db } };
  }
  const missing: string[] = [];
  if (!telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!telegramChatId) missing.push("TELEGRAM_CHAT_ID");
  if (!telegramWebhookSecret) missing.push("TELEGRAM_WEBHOOK_SECRET");
  if (!db) missing.push("DB");
  return { ok: false, missing };
}
