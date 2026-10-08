import type { Bot } from "grammy";
import { type Env, readStripeConfig, readTelegramConfig } from "./config";
import { makeOnPaymentReceived } from "./app/onPaymentReceived";
import { createStore, type Store } from "./db/store";
import type { Products } from "./domain/products";
import { handleStripeWebhook } from "./http/stripeWebhook";
import { handleTelegramWebhook } from "./http/telegramWebhook";
import { errName, json } from "./http/respond";
import type { Notifier } from "./notify/notifier";

export interface WorkerDeps {
  products?: Products;
  makeNotifier: (cfg: { telegramBotToken: string; telegramChatId: string }) => Notifier;
  makeBot: (cfg: { telegramBotToken: string; telegramChatId: string }, store: Store) => Promise<Bot>;
}

export function createWorker(deps: WorkerDeps) {
  return {
    async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
      try {
        const path = new URL(request.url).pathname;
        if (path !== "/stripe/webhook" && path !== "/telegram/webhook") return json(404, { error: "not found" });
        if (request.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });

        if (path === "/telegram/webhook") {
          const cfg = readTelegramConfig(env);
          if (!cfg.ok) {
            console.error("missing configuration:", cfg.missing.join(", "));
            return json(500, { error: "misconfigured" });
          }
          const { telegramBotToken, telegramChatId, telegramWebhookSecret, db } = cfg.config;
          return await handleTelegramWebhook(request, {
            secret: telegramWebhookSecret,
            makeBot: () => deps.makeBot({ telegramBotToken, telegramChatId }, createStore(db)),
          });
        }

        const cfg = readStripeConfig(env);
        if (!cfg.ok) {
          console.error("missing configuration:", cfg.missing.join(", "));
          return json(500, { error: "misconfigured" });
        }

        const notifier = deps.makeNotifier({
          telegramBotToken: cfg.config.telegramBotToken,
          telegramChatId: cfg.config.telegramChatId,
        });
        return await handleStripeWebhook(request, {
          webhookSecret: cfg.config.stripeWebhookSecret,
          onPaymentReceived: makeOnPaymentReceived({ notifier, store: createStore(cfg.config.db), products: deps.products }),
        });
      } catch (err) {
        console.error("worker failed:", errName(err));
        return json(500, { error: "internal" });
      }
    },
  };
}
