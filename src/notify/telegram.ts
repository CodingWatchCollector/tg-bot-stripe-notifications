import { Api, GrammyError } from "grammy";
import { type Notifier, NotifyError } from "./notifier";

export function createTelegramApi(token: string): Api {
  return new Api(token, { timeoutSeconds: 8 });
}

export function createTelegramNotifier(opts: { token: string; chatId: string; api?: Api }): Notifier {
  const api = opts.api ?? createTelegramApi(opts.token);
  return {
    async send(text, sendOpts) {
      const buttons = sendOpts?.buttons;
      try {
        const sent = await api.sendMessage(opts.chatId, text, {
          link_preview_options: { is_disabled: true },
          ...(buttons && {
            reply_markup: {
              inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
            },
          }),
        });
        return { messageId: sent.message_id };
      } catch (err) {
        if (err instanceof GrammyError) {
          throw new NotifyError(`telegram ${err.error_code}: ${err.description}`);
        }
        throw new NotifyError("telegram network error");
      }
    },
  };
}
