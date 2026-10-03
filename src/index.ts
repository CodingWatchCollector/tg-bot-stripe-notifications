import { createTelegramNotifier } from "./notify/telegram";
import { createWorker } from "./worker";

export default createWorker({
  makeNotifier: (cfg) => createTelegramNotifier({ token: cfg.telegramBotToken, chatId: cfg.telegramChatId }),
});
