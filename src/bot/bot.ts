import { Bot, GrammyError, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { adjustText, newStudentPrompt, paymentMessage, studentsText } from "../app/messages";
import type { AssignOutcome, DismissOutcome, Store } from "../db/store";
import { isValidName, isValidReason, nameKey, normalizeName } from "../domain/student";
import type { Button } from "../notify/notifier";

const INVALID_NAME = "Name must be 1-64 characters.";
const PROMPT = /^Name for the new student \(payment #(\d+)\):$/;
const CALLBACK = /^p:(\d+):(?:s:(\d+)|(new)|(x)|([+-]1))$/;
const COUNT = /^[+-]?\d+$/;
const MAX_ADJUST_CANDIDATES = 10;
const ADJUST_USAGE = "Usage: /adjust Name +5 [reason]";
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

export interface BotOptions {
  token: string;
  chatId: string;
  store: Store;
  botInfo: UserFromGetMe;
  fetch?: typeof fetch;
}

const inlineKeyboard = (buttons: Button[][]) => ({
  inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
});

const editOptions = (buttons?: Button[][]) => ({ ...NO_PREVIEW, ...(buttons && { reply_markup: inlineKeyboard(buttons) }) });

interface AdjustCandidate {
  name: string;
  count: string;
  reason: string;
}

// Every count token after the first is a possible split of "<name> <count> <reason>". The reason is optional and defaults to "-".
function adjustCandidates(arg: string): AdjustCandidate[] {
  const tokens = normalizeName(arg).split(" ").filter((t) => t !== "");
  const out: AdjustCandidate[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const count = tokens[i] ?? "";
    if (COUNT.test(count)) out.push({ name: tokens.slice(0, i).join(" "), count, reason: tokens.slice(i + 1).join(" ") || "-" });
  }
  return out;
}

async function editTolerant(edit: () => Promise<unknown>): Promise<void> {
  try {
    await edit();
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes("message is not modified")) return;
    throw err;
  }
}

export function createBot(opts: BotOptions): Bot {
  const { store } = opts;
  const bot = new Bot(opts.token, {
    botInfo: opts.botInfo,
    client: { timeoutSeconds: 8, ...(opts.fetch && { fetch: opts.fetch }) },
  });

  bot.use(async (ctx, next) => {
    if (String(ctx.chat?.id) !== opts.chatId) {
      console.log("telegram update from other chat ignored:", ctx.update.update_id);
      return;
    }
    await next();
  });

  bot.command("students", async (ctx) => {
    await ctx.reply(studentsText(await store.listStudentBalances()));
  });

  bot.command("adjust", async (ctx) => {
    const candidates = adjustCandidates(ctx.match);
    const leftmost = candidates[0];
    if (leftmost === undefined || candidates.length > MAX_ADJUST_CANDIDATES) return void (await ctx.reply(ADJUST_USAGE));

    for (const c of [...candidates].reverse()) {
      const student = await store.findStudentByNameKey(nameKey(c.name));
      if (student === null) continue;
      const delta = Number(c.count);
      if (delta === 0 || Math.abs(delta) > 99) return void (await ctx.reply("Count must be 1-99."));
      if (!isValidReason(c.reason)) return void (await ctx.reply("Reason must be 1-200 characters."));
      const outcome = await store.adjustStudent(student.id, delta, c.reason);
      switch (outcome.kind) {
        case "not_found":
          return void (await ctx.reply(`No student named ${c.name}.`));
        case "adjusted":
          return void (await ctx.reply(adjustText(outcome.student.name, delta, c.reason, outcome.before, outcome.after, outcome.unarchived)));
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    }
    await ctx.reply(`No student named ${leftmost.name}.`);
  });

  bot.command("rename", async (ctx) => {
    const usage = "Usage: /rename Old name -> New name";
    const arg = ctx.match;
    const at = arg.indexOf("->");
    if (at < 0) return void (await ctx.reply(usage));
    const oldName = normalizeName(arg.slice(0, at));
    const newName = normalizeName(arg.slice(at + 2));
    if (oldName === "" || newName === "") return void (await ctx.reply(usage));

    const student = await store.findStudentByNameKey(nameKey(oldName));
    if (student === null) return void (await ctx.reply(`No student named ${oldName}.`));
    if (!isValidName(newName)) return void (await ctx.reply(INVALID_NAME));

    const result = await store.renameStudent(student.id, newName);
    if (result === "ok") return void (await ctx.reply(`Renamed ${student.name} to ${newName}.`));
    if (result === "name_taken") {
      const other = await store.findStudentByNameKey(nameKey(newName));
      return void (await ctx.reply(`A student named ${other?.name ?? newName} already exists.`));
    }
    await ctx.reply(`No student named ${oldName}.`);
  });

  bot.on("callback_query:data", async (ctx) => {
    const answer = async (text?: string) => {
      try {
        await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
      } catch {
        // A failed answer must not stop the edit.
      }
    };
    const message = ctx.callbackQuery.message;
    if (message === undefined) return;
    const edit = ({ text, buttons }: { text: string; buttons?: Button[][] }) =>
      editTolerant(() => ctx.api.editMessageText(message.chat.id, message.message_id, text, editOptions(buttons)));

    const m = CALLBACK.exec(ctx.callbackQuery.data);
    if (m === null) return void (await answer("Not found"));
    const paymentId = Number(m[1]);

    const finish = async (outcome: AssignOutcome | DismissOutcome) => {
      switch (outcome.kind) {
        case "not_found":
          return answer("Not found");
        case "already_resolved":
          await answer("Already handled");
          return edit(paymentMessage(outcome.payment));
        case "assigned":
          await answer();
          return edit(paymentMessage(outcome.payment, { email: outcome.email, unarchived: outcome.unarchived }));
        case "dismissed":
          await answer();
          return edit(paymentMessage(outcome.payment));
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    };

    if (m[2] !== undefined) return finish(await store.assignPayment(paymentId, Number(m[2])));
    if (m[4] !== undefined) return finish(await store.dismissPayment(paymentId));
    if (m[5] !== undefined) {
      const outcome = await store.adjustPayment(paymentId, m[5] === "+1" ? 1 : -1);
      switch (outcome.kind) {
        case "not_found":
          return answer("Not found");
        case "adjusted":
          await answer();
          return edit(paymentMessage(outcome.payment));
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    }

    const payment = await store.getPayment(paymentId);
    if (payment === null) return void (await answer("Not found"));
    if (payment.status !== "unassigned") return finish({ kind: "already_resolved", payment });
    await answer();
    await ctx.api.sendMessage(opts.chatId, newStudentPrompt(paymentId), { reply_markup: { force_reply: true } });
  });

  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    const reply = ctx.message?.reply_to_message;
    if (text.startsWith("/") || reply?.from?.id !== ctx.me.id) return;
    const prompt = PROMPT.exec(reply.text ?? "");
    if (prompt === null) return;
    const paymentId = Number(prompt[1]);
    const name = normalizeName(text);

    if (!isValidName(name)) return void (await ctx.reply(INVALID_NAME));
    const outcome = await store.createStudentAndAssign(paymentId, name);
    switch (outcome.kind) {
      case "not_found":
        return void (await ctx.reply(`Payment #${paymentId} not found.`));
      case "already_resolved":
        return void (await ctx.reply(`Payment #${paymentId} is already handled.`));
      case "name_taken":
        return void (await ctx.reply(`A student named ${outcome.existing.name} already exists. Pick them from the list.`));
      case "assigned": {
        const { messageId } = outcome.payment;
        if (messageId !== null) {
          const { text, buttons } = paymentMessage(outcome.payment, { email: outcome.email, unarchived: outcome.unarchived });
          await editTolerant(() => ctx.api.editMessageText(opts.chatId, messageId, text, editOptions(buttons)));
        }
        await ctx.reply(`Added ${name}.`);
      }
    }
  });

  return bot;
}
