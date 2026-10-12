export interface Env {
  STRIPE_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DB?: D1Database;
  LESSON_CALENDARS?: string;
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

export interface CalendarSource {
  label: string;
  url: string;
}

export type LessonCalendarsResult = { ok: true; calendars: CalendarSource[] } | { ok: false; error: string };

const MAX_LABEL_LENGTH = 32;
const WEBCAL = /^webcal:\/\//i;
const HTTPS = /^https:\/\//i;

// Errors never echo input values: the urls are secrets.
export function readLessonCalendarsConfig(env: Env): LessonCalendarsResult {
  const fail = (error: string): LessonCalendarsResult => ({ ok: false, error: `LESSON_CALENDARS: ${error}` });
  const raw = text(env.LESSON_CALENDARS);
  if (!raw) return fail("missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("not valid JSON");
  }
  if (!Array.isArray(parsed)) return fail("must be a JSON array");
  if (parsed.length === 0) return fail("must not be empty");

  const calendars: CalendarSource[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return fail(`entry ${index} must be an object`);
    }
    const { label, url } = entry as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim()) return fail(`entry ${index} needs a non-blank label`);
    const name = label.trim();
    if ([...name].length > MAX_LABEL_LENGTH) {
      return fail(`entry ${index} label is longer than ${MAX_LABEL_LENGTH} characters`);
    }
    if (typeof url !== "string") return fail(`entry ${index} needs a url`);
    const address = url.trim();
    if (!WEBCAL.test(address) && !HTTPS.test(address)) return fail(`entry ${index} url must be https:// or webcal://`);
    const key = name.toLowerCase();
    if (seen.has(key)) return fail(`entry ${index} repeats a label`);
    seen.add(key);
    calendars.push({ label: name, url: address.replace(WEBCAL, "https://") });
  }
  return { ok: true, calendars };
}
