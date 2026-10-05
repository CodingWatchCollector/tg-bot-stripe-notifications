import { createBot } from "./bot/bot";
import { getBotInfo } from "./bot/botInfo";
import { createTelegramNotifier } from "./notify/telegram";
import { createWorker } from "./worker";

export default createWorker({
  makeNotifier: (cfg) => createTelegramNotifier({ token: cfg.telegramBotToken, chatId: cfg.telegramChatId }),
  makeBot: async (cfg, store) =>
    createBot({
      token: cfg.telegramBotToken,
      chatId: cfg.telegramChatId,
      store,
      botInfo: await getBotInfo(cfg.telegramBotToken),
    }),
});
