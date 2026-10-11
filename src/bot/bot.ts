import { Bot, GrammyError, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { emailTag, parseCallback, type Callback } from "../app/callbacks";
import { helpText } from "../app/commands";
import {
  adjustText,
  archivedText,
  cardMessage,
  emailRemovalButtons,
  paymentMessage,
  studentListButtons,
  studentsText,
  unarchivedLine,
} from "../app/messages";
import { newStudentPrompt, parsePrompt, promptText } from "../app/prompts";
import type { AssignOutcome, DismissOutcome, Store, StudentCard } from "../db/store";
import {
  isValidEmail,
  isValidName,
  isValidReason,
  nameKey,
  normalizeEmail,
  normalizeName,
  parseUsername,
} from "../domain/student";
import type { Button } from "../notify/notifier";

const INVALID_NAME = "Name must be 1-64 characters.";
const COUNT = /^[+-]?\d+$/;
const MAX_ADJUST_CANDIDATES = 10;
const ADJUST_USAGE = "Usage: /adjust Name +5 [reason]";
const INVALID_EMAIL = "That does not look like an email address.";
const INVALID_USERNAME = "A username is 4-32 letters, digits or underscores, starting with a letter.";
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

  const listReply = (text: string, rows: Button[][]) => ({
    text,
    options: { ...NO_PREVIEW, ...(rows.length > 0 && { reply_markup: inlineKeyboard(rows) }) },
  });

  bot.command(["help", "start"], async (ctx) => {
    await ctx.reply(helpText());
  });

  bot.command("students", async (ctx) => {
    const students = await store.listStudentBalances();
    const { text, options } = listReply(studentsText(students), studentListButtons(students));
    await ctx.reply(text, options);
  });

  bot.command("archived", async (ctx) => {
    const students = await store.listStudentBalances(true);
    const { text, options } = listReply(archivedText(students), studentListButtons(students));
    await ctx.reply(text, options);
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

    const outcome = await store.renameStudent(student.id, newName);
    switch (outcome.kind) {
      case "renamed":
        return void (await ctx.reply(`Renamed ${student.name} to ${newName}.`));
      case "name_taken":
        return void (await ctx.reply(`A student named ${outcome.existing.name} already exists.`));
      case "not_found":
        return void (await ctx.reply(`No student named ${oldName}.`));
      default: {
        const unreachable: never = outcome;
        return unreachable;
      }
    }
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

    const cb = parseCallback(ctx.callbackQuery.data);
    if (cb === null) return void (await answer("Not found"));

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

    const editCard = async (card: StudentCard, answerText?: string, note?: string) => {
      await answer(answerText);
      return edit(cardMessage(card, note));
    };

    const askFor = async (card: StudentCard, kind: "rename" | "add_email" | "username") => {
      await answer();
      await ctx.api.sendMessage(opts.chatId, promptText({ kind, studentId: card.id }, card.name), { reply_markup: { force_reply: true } });
    };

    const studentTap = async (tap: Extract<Callback, { kind: "student" }>) => {
      const studentId = tap.studentId;
      const withCard = async (use: (card: StudentCard) => Promise<unknown>) => {
        const card = await store.getStudentCard(studentId);
        return card === null ? answer("Not found") : use(card);
      };
      switch (tap.action) {
        case "-1":
        case "+1": {
          const outcome = await store.adjustStudent(studentId, tap.action === "+1" ? 1 : -1, "-");
          switch (outcome.kind) {
            case "not_found":
              return answer("Not found");
            case "adjusted": {
              const card = await store.getStudentCard(studentId);
              if (card === null) throw new Error("student missing after write");
              return editCard(card, undefined, outcome.unarchived ? unarchivedLine(card.name) : undefined);
            }
            default: {
              const unreachable: never = outcome;
              return unreachable;
            }
          }
        }
        case "archive":
        case "unarchive": {
          const outcome = await store.setArchived(studentId, tap.action === "archive");
          switch (outcome.kind) {
            case "not_found":
              return answer("Not found");
            case "updated":
              return editCard(outcome.card);
            case "already_resolved":
              return editCard(outcome.card, "Already handled");
            default: {
              const unreachable: never = outcome;
              return unreachable;
            }
          }
        }
        case "open":
          return withCard(async (card) => {
            await answer();
            const { text, buttons } = cardMessage(card);
            await ctx.api.sendMessage(opts.chatId, text, { ...NO_PREVIEW, reply_markup: inlineKeyboard(buttons) });
          });
        case "card":
          return withCard((card) => editCard(card));
        case "name":
          return withCard((card) => askFor(card, "rename"));
        case "user":
          return withCard((card) => askFor(card, "username"));
        case "email+":
          return withCard((card) => askFor(card, "add_email"));
        case "email-":
          return withCard(async (card) => {
            if (card.emails.length === 0) return editCard(card, "Not found");
            await answer();
            return edit({ text: cardMessage(card).text, buttons: emailRemovalButtons(card) });
          });
        default: {
          const unreachable: never = tap.action;
          return unreachable;
        }
      }
    };

    switch (cb.kind) {
      case "assign":
        return finish(await store.assignPayment(cb.paymentId, cb.studentId));
      case "dismiss":
        return finish(await store.dismissPayment(cb.paymentId));
      case "adjust_payment": {
        const outcome = await store.adjustPayment(cb.paymentId, cb.delta);
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
      case "new_student": {
        const payment = await store.getPayment(cb.paymentId);
        if (payment === null) return void (await answer("Not found"));
        if (payment.status !== "unassigned") return finish({ kind: "already_resolved", payment });
        await answer();
        await ctx.api.sendMessage(opts.chatId, newStudentPrompt(cb.paymentId), { reply_markup: { force_reply: true } });
        return;
      }
      case "student":
        return studentTap(cb);
      case "remove_email": {
        const card = await store.getStudentCard(cb.studentId);
        if (card === null) return answer("Not found");
        const matches = card.emails.filter((email) => emailTag(email) === cb.tag);
        const [email] = matches;
        if (matches.length !== 1 || email === undefined) return editCard(card, "Not found");
        const outcome = await store.removeEmail(cb.studentId, email);
        switch (outcome.kind) {
          case "removed":
            return editCard(outcome.card);
          case "already_resolved":
            return editCard(outcome.card, "Already handled");
          case "not_found":
            return answer("Not found");
          default: {
            const unreachable: never = outcome;
            return unreachable;
          }
        }
      }
      default: {
        const unreachable: never = cb;
        return unreachable;
      }
    }
  });

  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    const reply = ctx.message?.reply_to_message;
    if (text.startsWith("/") || reply?.from?.id !== ctx.me.id) return;
    const prompt = parsePrompt(reply.text ?? "");
    if (prompt === null) return;

    const replyCard = async (card: StudentCard, note: string) => {
      const { text: cardText, buttons } = cardMessage(card, note);
      await ctx.reply(cardText, { ...NO_PREVIEW, reply_markup: inlineKeyboard(buttons) });
    };
    const notFound = (studentId: number) => ctx.reply(`Student #${studentId} not found.`);

    switch (prompt.kind) {
      case "new_student": {
        const paymentId = prompt.paymentId;
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
            return;
          }
          default: {
            const unreachable: never = outcome;
            return unreachable;
          }
        }
      }
      case "rename": {
        const name = normalizeName(text);
        if (!isValidName(name)) return void (await ctx.reply(INVALID_NAME));
        const outcome = await store.renameStudent(prompt.studentId, name);
        switch (outcome.kind) {
          case "renamed":
            return replyCard(outcome.card, `✅ Renamed ${outcome.previousName} to ${outcome.card.name}.`);
          case "name_taken":
            return void (await ctx.reply(`A student named ${outcome.existing.name} already exists.`));
          case "not_found":
            return void (await notFound(prompt.studentId));
          default: {
            const unreachable: never = outcome;
            return unreachable;
          }
        }
      }
      case "add_email": {
        const email = normalizeEmail(text);
        if (!isValidEmail(email)) return void (await ctx.reply(INVALID_EMAIL));
        const outcome = await store.addEmail(prompt.studentId, email);
        switch (outcome.kind) {
          case "added":
            return replyCard(outcome.card, `✅ Added ${email} to ${outcome.card.name}.`);
          case "already_resolved":
            return replyCard(outcome.card, `${email} is already ${outcome.card.name}'s email.`);
          case "email_taken":
            return void (await ctx.reply(`${email} already belongs to ${outcome.owner.name}.`));
          case "not_found":
            return void (await notFound(prompt.studentId));
          default: {
            const unreachable: never = outcome;
            return unreachable;
          }
        }
      }
      case "username": {
        const parsed = parseUsername(text);
        if (parsed === null) return void (await ctx.reply(INVALID_USERNAME));
        const outcome = await store.setUsername(prompt.studentId, parsed.username);
        switch (outcome.kind) {
          case "updated":
            return replyCard(
              outcome.card,
              parsed.username === null
                ? `✅ Cleared ${outcome.card.name}'s Telegram username.`
                : `✅ Saved @${parsed.username} for ${outcome.card.name}.`,
            );
          case "not_found":
            return void (await notFound(prompt.studentId));
          default: {
            const unreachable: never = outcome;
            return unreachable;
          }
        }
      }
      default: {
        const unreachable: never = prompt;
        return unreachable;
      }
    }
  });

  return bot;
}
