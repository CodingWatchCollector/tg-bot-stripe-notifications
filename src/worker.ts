import { type Env, readConfig } from "./config";
import { makeOnPaymentReceived } from "./app/onPaymentReceived";
import { handleStripeWebhook } from "./http/stripeWebhook";
import { errName, json } from "./http/respond";
import type { Notifier } from "./notify/notifier";

export interface WorkerDeps {
  makeNotifier: (cfg: { telegramBotToken: string; telegramChatId: string }) => Notifier;
}

export function createWorker(deps: WorkerDeps) {
  return {
    async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
      try {
        if (new URL(request.url).pathname !== "/stripe/webhook") return json(404, { error: "not found" });
        if (request.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });

        const cfg = readConfig(env);
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
          onPaymentReceived: makeOnPaymentReceived({ notifier }),
        });
      } catch (err) {
        console.error("worker failed:", errName(err));
        return json(500, { error: "internal" });
      }
    },
  };
}
