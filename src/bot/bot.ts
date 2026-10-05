import { Bot, GrammyError, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import {
  assignedText,
  dismissedText,
  newStudentPrompt,
  studentsText,
  unknownPayerText,
  type EmailOutcome,
} from "../app/messages";
import type { AssignOutcome, PaymentView, Store } from "../db/store";
import { isValidName, nameKey, normalizeName } from "../domain/student";

const INVALID_NAME = "Name must be 1-64 characters.";
const PROMPT = /^Name for the new student \(payment #(\d+)\):$/;
const CALLBACK = /^p:(\d+):(?:s:(\d+)|(new)|(x))$/;
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

export interface BotOptions {
  token: string;
  chatId: string;
  store: Store;
  botInfo: UserFromGetMe;
  fetch?: typeof fetch;
}

function currentText(p: PaymentView, email: EmailOutcome = "none"): string {
  if (p.status === "assigned") return assignedText(p.studentName ?? "unknown", p, email);
  if (p.status === "dismissed") return dismissedText(p);
  return unknownPayerText(p);
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
    await ctx.reply(studentsText(await store.listActiveStudents()));
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
    const edit = (text: string) =>
      editTolerant(() => ctx.api.editMessageText(message.chat.id, message.message_id, text, NO_PREVIEW));

    const m = CALLBACK.exec(ctx.callbackQuery.data);
    if (m === null) return void (await answer("Not found"));
    const paymentId = Number(m[1]);

    const finish = async (outcome: AssignOutcome | "ok" | "already_resolved" | "not_found") => {
      if (outcome === "not_found" || (typeof outcome === "object" && outcome.kind === "not_found")) {
        return answer("Not found");
      }
      if (outcome === "ok") {
        await answer();
        const p = await store.getPayment(paymentId);
        return p === null ? undefined : edit(currentText(p));
      }
      if (outcome === "already_resolved") {
        await answer("Already handled");
        const p = await store.getPayment(paymentId);
        return p === null ? undefined : edit(currentText(p));
      }
      if (outcome.kind === "already_resolved") {
        await answer("Already handled");
        return edit(currentText(outcome.payment));
      }
      await answer();
      return edit(currentText(outcome.payment, outcome.email));
    };

    if (m[2] !== undefined) return finish(await store.assignPayment(paymentId, Number(m[2])));
    if (m[4] !== undefined) return finish(await store.dismissPayment(paymentId));

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
          await editTolerant(() =>
            ctx.api.editMessageText(opts.chatId, messageId, currentText(outcome.payment, outcome.email), NO_PREVIEW),
          );
        }
        await ctx.reply(`Added ${name}.`);
      }
    }
  });

  return bot;
}
