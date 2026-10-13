import { describe, expect, test } from "vitest";
import {
  archivedText,
  assignedText,
  cardMessage,
  archiveConfirmMessage,
  emailRemovalButtons,
  titleRemovalButtons,
  studentListButtons,
  customerLine,
  dashboardLink,
  dismissedText,
  formatAmount,
  adjustText,
  paidPhrase,
  paymentButtons,
  paymentMessage,
  pickerButtons,
  studentsText,
  unknownPayerText,
  type PaymentFacts,
} from "../src/app/messages";
import type { PaymentView } from "../src/db/store";
import type { StudentCard } from "../src/db/store";
import {
  compareNames,
  isValidEmail,
  isValidName,
  isValidReason,
  nameKey,
  normalizeEmail,
  normalizeName,
  parseUsername,
  type Student,
} from "../src/domain/student";
import { newStudentPrompt } from "../src/app/prompts";

const base: PaymentFacts = {
  amountMinor: 16000,
  currency: "eur",
  customerName: "Anna K",
  customerEmail: "anna@example.com",
  paymentIntentId: "pi_123",
};
const LINK = "https://dashboard.stripe.com/payments/pi_123";
const EUR160 = "160,00\u00a0€";

const student = (id: number, name: string): Student => ({
  id,
  name,
  nameKey: nameKey(name),
  telegramUsername: null,
  archived: false,
  createdAt: "t",
});

describe("formatAmount", () => {
  test.each([
    [16000, "eur", "160,00\u00a0€"],
    [16000, "EUR", "160,00\u00a0€"],
    [123450, "eur", "1\u202f234,50\u00a0€"],
    [50, "eur", "0,50\u00a0€"],
    [16000, "usd", "160,00\u00a0$US"],
  ])("%s %s", (amount, currency, text) => expect(formatAmount(amount, currency)).toBe(text));
  test("unknown amount", () => expect(formatAmount(null, "eur")).toBe("amount unknown"));
  test("unknown currency", () => expect(formatAmount(4500, null)).toBe("amount unknown"));
});

describe("dashboardLink", () => {
  test("live", () => expect(dashboardLink("pi_123")).toBe(LINK));
  test("no payment intent", () => expect(dashboardLink(null)).toBeNull());
});

describe("customerLine", () => {
  test.each([
    [null, null, "unknown <unknown>"],
    ["Anna K", null, "Anna K <unknown>"],
    [null, "anna@example.com", "unknown <anna@example.com>"],
    ["Anna K", "anna@example.com", "Anna K <anna@example.com>"],
  ])("name=%s email=%s", (customerName, customerEmail, line) => {
    expect(customerLine({ customerName, customerEmail })).toBe(line);
  });
});

describe("templates", () => {
  test("known payer", () => {
    expect(assignedText("Olena", base)).toBe(`💶 Olena paid ${EUR160}\n${LINK}`);
  });

  test("link line is omitted without a payment intent", () => {
    expect(assignedText("Olena", { ...base, paymentIntentId: null })).toBe(`💶 Olena paid ${EUR160}`);
  });

  test("unknown payer", () => {
    expect(unknownPayerText(base)).toBe(`💶 Unknown payer paid ${EUR160}\nAnna K <anna@example.com>\nWho is this?\n${LINK}`);
  });

  test("unknown amount in a template", () => {
    expect(assignedText("Olena", { ...base, amountMinor: null })).toBe(`💶 Olena paid amount unknown\n${LINK}`);
  });

  test("assigned with a saved email", () => {
    expect(assignedText("Ira + Pasha", base, "saved")).toBe(
      `💶 Ira + Pasha paid ${EUR160}\nanna@example.com saved as Ira + Pasha's email\n${LINK}`,
    );
  });

  test("assigned with an email owned by another student", () => {
    expect(assignedText("Ira + Pasha", base, { ownedBy: { name: "Olena" } })).toBe(
      `💶 Ira + Pasha paid ${EUR160}\nanna@example.com already belongs to Olena\n${LINK}`,
    );
  });

  test.each([["none" as const], ["saved" as const]])("assigned without an email has no second line (%s)", (outcome) => {
    expect(assignedText("Ira", { ...base, customerEmail: null }, outcome)).toBe(`💶 Ira paid ${EUR160}\n${LINK}`);
  });

  test("assigned, nothing to report", () => {
    expect(assignedText("Ira", base)).toBe(`💶 Ira paid ${EUR160}\n${LINK}`);
  });

  test("dismissed", () => {
    expect(dismissedText(base)).toBe(`💶 Payment dismissed: ${EUR160}\nAnna K <anna@example.com>\n${LINK}`);
  });
});

describe("pickerButtons", () => {
  const texts = (rows: { text: string }[][]) => rows.map((r) => r.map((b) => b.text));

  test("layout: new, students two per row, cancel", () => {
    const rows = pickerButtons(7, [student(3, "Cora"), student(1, "Olena"), student(2, "Ira + Pasha")], null);
    expect(texts(rows)).toEqual([["➕ New student"], ["Cora", "Ira + Pasha"], ["Olena"], ["✖️ Cancel"]]);
    expect(rows[0]?.[0]?.data).toBe("p:7:new");
    expect(rows[1]?.[1]?.data).toBe("p:7:s:2");
    expect(rows.at(-1)?.[0]?.data).toBe("p:7:x");
  });

  test("suggestion row follows New student and is not repeated", () => {
    const rows = pickerButtons(7, [student(1, "Olena"), student(2, "Ira")], " olena ");
    expect(texts(rows)).toEqual([["➕ New student"], ["💡 Olena"], ["Ira"], ["✖️ Cancel"]]);
    expect(rows[1]?.[0]?.data).toBe("p:7:s:1");
  });

  test("no suggestion without a match or name", () => {
    expect(texts(pickerButtons(7, [student(1, "Olena")], "Old One"))).toEqual([["➕ New student"], ["Olena"], ["✖️ Cancel"]]);
    expect(texts(pickerButtons(7, [student(1, "Olena")], null))).toEqual([["➕ New student"], ["Olena"], ["✖️ Cancel"]]);
  });

  test("shows the first 90 students in name order", () => {
    const many = Array.from({ length: 91 }, (_, i) => student(i + 1, `S${String(i).padStart(3, "0")}`));
    const rows = pickerButtons(1, [...many].reverse(), null);
    const names = rows.slice(1, -1).flat().map((b) => b.text);
    expect(names).toHaveLength(90);
    expect(names[0]).toBe("S000");
    expect(names[89]).toBe("S089");
  });

  test("the suggestion counts toward the 90 student buttons", () => {
    const many = Array.from({ length: 91 }, (_, i) => student(i + 1, `S${String(i).padStart(3, "0")}`));
    const rows = pickerButtons(1, many, "s050");
    const middle = rows.slice(1, -1);
    expect(texts(rows)[0]).toEqual(["➕ New student"]);
    expect(texts(rows).at(-1)).toEqual(["✖️ Cancel"]);
    expect(texts(middle)[0]).toEqual(["💡 S050"]);
    const rest = middle.slice(1);
    expect(rest).toHaveLength(45);
    expect(rest.at(-1)).toHaveLength(1);
    const names = rest.flat().map((b) => b.text);
    expect(names).toHaveLength(89);
    expect(names[0]).toBe("S000");
    expect(names[88]).toBe("S089");
    expect(names).not.toContain("S050");
    expect(middle.flat()).toHaveLength(90);
  });

  test("callback data stays within 64 bytes", () => {
    const rows = pickerButtons(123456789, [student(987654321, "Olena")], "Olena");
    for (const b of rows.flat()) expect(new TextEncoder().encode(b.data).length).toBeLessThanOrEqual(64);
  });
});

describe("command replies", () => {
  test("students list", () => {
    expect(
      studentsText([
        { id: 1, name: "Olena", balance: 0 },
        { id: 2, name: "ira + pasha 2", balance: 0 },
        { id: 3, name: "Ira + Pasha", balance: 0 },
      ]),
    ).toBe("Students (3):\nIra + Pasha: 0\nira + pasha 2: 0\nOlena: 0");
  });
  test("students list shows each Balance, negative with a minus", () => {
    expect(
      studentsText([
        { id: 1, name: "Olena", balance: 5 },
        { id: 2, name: "ira + pasha 2", balance: -1 },
        { id: 3, name: "Ira + Pasha", balance: 0 },
      ]),
    ).toBe("Students (3):\nIra + Pasha: 0\nira + pasha 2: -1\nOlena: 5");
  });
  test("no students", () => expect(studentsText([])).toBe("No students yet."));
  test("new student prompt", () => expect(newStudentPrompt(12)).toBe("Name for the new student (payment #12):"));
});

describe("names", () => {
  test("normalizeName trims and collapses whitespace", () => expect(normalizeName("  Marie   Curie ")).toBe("Marie Curie"));
  test("nameKey lowercases", () => expect(nameKey(" Marie  CURIE")).toBe("marie curie"));
  test("compareNames ignores case and breaks ties by id", () => {
    expect([student(2, "bob"), student(3, "Alice"), student(1, "Bob")].sort(compareNames).map((s) => s.id)).toEqual([3, 1, 2]);
  });
  test("isValidName counts code points after normalizing", () => {
    expect(isValidName("   ")).toBe(false);
    expect(isValidName("a")).toBe(true);
    expect(isValidName("😀".repeat(64))).toBe(true);
    expect(isValidName("😀".repeat(65))).toBe(false);
    expect(isValidName(`a  ${"b".repeat(61)}`)).toBe(true);
  });
});

const T4 = "Індивідуальний пакет 4";
const CLUB = "Клуб B2/C1 — поурочно";

const view = (over: Partial<PaymentView> = {}): PaymentView => ({
  id: 7,
  checkoutSessionId: "cs_1",
  status: "assigned",
  studentId: 1,
  studentName: "Olena",
  amountMinor: 16000,
  currency: "eur",
  customerName: "Anna K",
  customerEmail: "anna@example.com",
  paymentIntentId: "pi_123",
  paymentLinkId: "plink_t4",
  messageId: 50,
  notifiedAt: "n",
  createdAt: "t",
  lessons: 4,
  productName: T4,
  correction: 0,
  studentBalance: 5,
  ...over,
});

describe("paidPhrase", () => {
  test("a Pack names the lessons, the product and the amount", () => {
    expect(paidPhrase({ ...base, lessons: 4, productName: T4 })).toBe(`paid for 4 lessons (${T4}, ${EUR160})`);
  });

  test("one lesson is singular", () => {
    expect(paidPhrase({ ...base, lessons: 1, productName: "Індивідуальне — поурочно" })).toBe(
      `paid for 1 lesson (Індивідуальне — поурочно, ${EUR160})`,
    );
  });

  test("a Pack without a product name still renders as a Pack", () => {
    expect(paidPhrase({ ...base, lessons: 4, productName: null })).toBe(`paid for 4 lessons (unknown product, ${EUR160})`);
  });

  test("a name-only product shows the amount and the name", () => {
    expect(paidPhrase({ ...base, lessons: 0, productName: CLUB })).toBe(`paid ${EUR160} for ${CLUB}`);
  });

  test.each([[{}], [{ lessons: 0, productName: null }]])("an unlisted product keeps today's wording %#", (over) => {
    expect(paidPhrase({ ...base, ...over })).toBe(`paid ${EUR160}`);
  });
});

describe("product names in the other templates", () => {
  test("unknown payer Pack", () => {
    expect(unknownPayerText({ ...base, lessons: 4, productName: T4 })).toBe(
      `💶 Unknown payer paid for 4 lessons (${T4}, ${EUR160})\nAnna K <anna@example.com>\nWho is this?\n${LINK}`,
    );
  });

  test("unknown payer name-only product", () => {
    expect(unknownPayerText({ ...base, lessons: 0, productName: CLUB })).toBe(
      `💶 Unknown payer paid ${EUR160} for ${CLUB}\nAnna K <anna@example.com>\nWho is this?\n${LINK}`,
    );
  });

  test("assigned name-only product with a saved email", () => {
    expect(assignedText("Marta", { ...base, lessons: 0, productName: CLUB }, "saved")).toBe(
      `💶 Marta paid ${EUR160} for ${CLUB}\nanna@example.com saved as Marta's email\n${LINK}`,
    );
  });

  test("dismissed names the product", () => {
    expect(dismissedText({ ...base, lessons: 4, productName: T4 })).toBe(
      `💶 Payment dismissed: ${EUR160} for ${T4}\nAnna K <anna@example.com>\n${LINK}`,
    );
  });
});

describe("paymentMessage", () => {
  const BUTTONS = [[{ text: "-1", data: "p:7:-1" }, { text: "+1", data: "p:7:+1" }]];

  test("a Pack shows the Balance before and after, with the correction buttons", () => {
    expect(paymentMessage(view({ studentBalance: 5 }))).toEqual({
      text: `💶 Olena paid for 4 lessons (${T4}, ${EUR160})\nBalance: 1 → 5\n${LINK}`,
      buttons: BUTTONS,
    });
  });

  test("one lesson", () => {
    const out = paymentMessage(view({ lessons: 1, productName: "Індивідуальне — поурочно", studentBalance: 2 }));
    expect(out.text).toBe(`💶 Olena paid for 1 lesson (Індивідуальне — поурочно, ${EUR160})\nBalance: 1 → 2\n${LINK}`);
  });

  test.each([
    [1, 6, "Correction: +1\nBalance: 1 → 6"],
    [-2, 2, "Correction: -2\nBalance: 0 → 2"],
    [0, 4, "Balance: 0 → 4"],
  ])("correction %s with Balance %s", (correction, balance, lines) => {
    expect(paymentMessage(view({ correction, studentBalance: balance })).text).toBe(
      `💶 Olena paid for 4 lessons (${T4}, ${EUR160})\n${lines}\n${LINK}`,
    );
  });

  test("negative Balances render with a minus", () => {
    expect(paymentMessage(view({ studentBalance: -1 })).text).toContain("Balance: -5 → -1");
  });

  test("notes come before the correction and the Balance, the email first", () => {
    const out = paymentMessage(view({ studentBalance: 4, studentName: "Marta" }), { email: "saved", unarchived: true });
    expect(out.text).toBe(
      `💶 Marta paid for 4 lessons (${T4}, ${EUR160})\nanna@example.com saved as Marta's email\nMarta was archived and is active again.\nBalance: 0 → 4\n${LINK}`,
    );
  });

  test("an email owned by someone else", () => {
    const out = paymentMessage(view({ studentBalance: 4 }), { email: { ownedBy: { name: "Ira" } } });
    expect(out.text).toContain("\nanna@example.com already belongs to Ira\n");
  });

  test("the link line is omitted without a payment intent", () => {
    expect(paymentMessage(view({ paymentIntentId: null, studentBalance: 4 })).text.endsWith("\nBalance: 0 → 4")).toBe(true);
  });

  test("a name-only payment has no Balance and no buttons", () => {
    expect(paymentMessage(view({ lessons: 0, productName: CLUB, studentBalance: 9 }), { email: "saved" })).toEqual({
      text: `💶 Olena paid ${EUR160} for ${CLUB}\nanna@example.com saved as Olena's email\n${LINK}`,
    });
  });

  test("an unlisted assigned payment keeps today's text", () => {
    expect(paymentMessage(view({ lessons: 0, productName: null }))).toEqual({ text: `💶 Olena paid ${EUR160}\n${LINK}` });
  });

  test("a dismissed payment has no buttons", () => {
    expect(paymentMessage(view({ status: "dismissed", studentId: null, studentName: null, studentBalance: null }))).toEqual({
      text: `💶 Payment dismissed: ${EUR160} for ${T4}\nAnna K <anna@example.com>\n${LINK}`,
    });
  });

  test("an unassigned payment renders the unknown payer text without buttons", () => {
    expect(paymentMessage(view({ status: "unassigned", studentId: null, studentName: null, studentBalance: null }))).toEqual({
      text: `💶 Unknown payer paid for 4 lessons (${T4}, ${EUR160})\nAnna K <anna@example.com>\nWho is this?\n${LINK}`,
    });
  });
});

describe("paymentButtons", () => {
  test("-1 and +1 in one row", () => {
    expect(paymentButtons(12)).toEqual([[{ text: "-1", data: "p:12:-1" }, { text: "+1", data: "p:12:+1" }]]);
  });
});

describe("adjustText", () => {
  test("a positive adjustment", () => {
    expect(adjustText("Olena", 5, "opening balance", 0, 5, false)).toBe("Olena: +5 (opening balance). Balance: 0 → 5");
  });

  test("a negative adjustment", () => {
    expect(adjustText("Ira + Pasha", -1, "missed lesson", 2, 1, false)).toBe("Ira + Pasha: -1 (missed lesson). Balance: 2 → 1");
  });

  test("an unarchived Student gets a second line", () => {
    expect(adjustText("Old One", 2, "back from break", 0, 2, true)).toBe(
      "Old One: +2 (back from break). Balance: 0 → 2\nOld One was archived and is active again.",
    );
  });
});

describe("isValidReason", () => {
  test.each([
    ["", false],
    ["   ", false],
    ["x", true],
    ["-", true],
    ["a".repeat(200), true],
    ["a".repeat(201), false],
    ["😀".repeat(200), true],
    ["😀".repeat(201), false],
    [`a  ${"b".repeat(197)}`, true],
  ])("%j -> %s", (reason, ok) => {
    expect(isValidReason(reason)).toBe(ok);
  });
});

describe("student list keyboard", () => {
  test("two buttons per row in name order", () => {
    const rows = studentListButtons([
      { id: 3, name: "Olena", balance: 5 },
      { id: 2, name: "ira + pasha 2", balance: -1 },
      { id: 1, name: "Ira + Pasha", balance: 0 },
    ]);
    expect(rows).toEqual([
      [
        { text: "Ira + Pasha", data: "s:1:open" },
        { text: "ira + pasha 2", data: "s:2:open" },
      ],
      [{ text: "Olena", data: "s:3:open" }],
    ]);
  });

  test("at most 90 buttons, the first 90 by name", () => {
    const summaries = Array.from({ length: 91 }, (_, i) => ({ id: i + 1, name: `S${String(i).padStart(2, "0")}`, balance: 0 }));
    const rows = studentListButtons([...summaries].reverse());
    expect(rows).toHaveLength(45);
    expect(rows.flat()).toHaveLength(90);
    expect(rows.flat().map((b) => b.text)).toEqual(summaries.slice(0, 90).map((s) => s.name));
  });
});

describe("archivedText", () => {
  test("lists in compareNames order", () => {
    expect(
      archivedText([
        { id: 2, name: "bob", balance: 1 },
        { id: 1, name: "Bob", balance: 0 },
        { id: 3, name: "Ada", balance: -1 },
      ]),
    ).toBe("Archived students (3):\nAda: -1\nBob: 0\nbob: 1");
  });

  test("empty", () => {
    expect(archivedText([])).toBe("No archived students.");
  });
});

describe("cardMessage", () => {
  const card: StudentCard = {
    id: 4,
    name: "Olena",
    nameKey: "olena",
    telegramUsername: "olena_k",
    archived: false,
    createdAt: "t",
    balance: 5,
    emails: ["o2@example.com", "olena@example.com"],
    calendarNames: [],
  };

  test("an active card", () => {
    expect(cardMessage(card)).toEqual({
      text: "👤 Olena\nBalance: 5\nEmails: o2@example.com, olena@example.com\nTelegram: @olena_k\nCalendar names: none",
      buttons: [
        [
          { text: "-1", data: "s:4:-1" },
          { text: "+1", data: "s:4:+1" },
        ],
        [
          { text: "✏️ Rename", data: "s:4:name" },
          { text: "👤 Username", data: "s:4:user" },
        ],
        [
          { text: "➕ Email", data: "s:4:email+" },
          { text: "➖ Email", data: "s:4:email-" },
        ],
        [{ text: "➕ Calendar name", data: "s:4:title+" }],
        [{ text: "🗄 Archive", data: "s:4:archive" }],
      ],
    });
  });

  test("an archived card without emails or username", () => {
    const out = cardMessage({ ...card, archived: true, emails: [], telegramUsername: null, balance: 0, name: "Old One" });
    expect(out.text).toBe("👤 Old One (archived)\nBalance: 0\nEmails: none\nTelegram: not set\nCalendar names: none");
    expect(out.buttons.map((row) => row.map((b) => b.text))).toEqual([["-1", "+1"], ["✏️ Rename", "👤 Username"], ["➕ Email"], ["📤 Unarchive"]]);
    expect(out.buttons[3]).toEqual([{ text: "📤 Unarchive", data: "s:4:unarchive" }]);
  });

  describe("Calendar names", () => {
    const DUO = "Duo B2/C1 (Mira K, Yeva)";
    const duo = { title: DUO, titleKey: "duo b2/c1 (mira k, yeva)", sharedWith: ["Yeva"] };
    const marko = { title: "Marko", titleKey: "marko", sharedWith: [] };
    const labels = (out: ReturnType<typeof cardMessage>) => out.buttons.map((row) => row.map((b) => b.text));

    test("lists each name with who it is shared with", () => {
      const out = cardMessage({ ...card, calendarNames: [duo, marko] });
      expect(out.text.split("\n").slice(-3)).toEqual(["Calendar names:", `\u2022 ${DUO}, shared with Yeva`, "\u2022 Marko"]);
      expect(labels(out)[3]).toEqual(["\u2795 Calendar name", "\u2796 Calendar name"]);
      expect(out.buttons[3]).toEqual([
        { text: "\u2795 Calendar name", data: "s:4:title+" },
        { text: "\u2796 Calendar name", data: "s:4:title-" },
      ]);
    });

    test("joins several Students", () => {
      const out = cardMessage({ ...card, calendarNames: [{ ...duo, sharedWith: ["Mira K", "Taras"] }] });
      expect(out.text.split("\n").at(-1)).toBe(`\u2022 ${DUO}, shared with Mira K, Taras`);
    });

    test("an archived card with no names has no Calendar name row", () => {
      const out = cardMessage({ ...card, archived: true });
      expect(labels(out)).toEqual([["-1", "+1"], ["\u270F\uFE0F Rename", "\u{1F464} Username"], ["\u2795 Email", "\u2796 Email"], ["\u{1F4E4} Unarchive"]]);
    });

    test("an archived card with a leftover name can only remove it", () => {
      const out = cardMessage({ ...card, archived: true, calendarNames: [marko] });
      expect(labels(out).slice(3)).toEqual([["\u2796 Calendar name"], ["\u{1F4E4} Unarchive"]]);
    });
  });

  test("a note is the first line", () => {
    expect(cardMessage(card, "✅ Saved.").text.split("\n").slice(0, 2)).toEqual(["✅ Saved.", "👤 Olena"]);
  });
});

describe("emailRemovalButtons", () => {
  test("one row per email, then Back", () => {
    const card = { id: 4, emails: ["o2@example.com", "olena@example.com"] } as StudentCard;
    expect(emailRemovalButtons(card)).toEqual([
      [{ text: "✖️ o2@example.com", data: "s:4:rm:e5bb3129" }],
      [{ text: "✖️ olena@example.com", data: "s:4:rm:7007e771" }],
      [{ text: "⬅️ Back", data: "s:4:card" }],
    ]);
  });
});

describe("titleRemovalButtons", () => {
  test("one row per name, then Back", () => {
    const card = {
      id: 4,
      calendarNames: [
        { title: "Duo B2/C1 (Mira K, Yeva)", titleKey: "duo b2/c1 (mira k, yeva)", sharedWith: ["Yeva"] },
        { title: "Marko", titleKey: "marko", sharedWith: [] },
      ],
    } as StudentCard;
    const rows = titleRemovalButtons(card);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ["\u2716\uFE0F Duo B2/C1 (Mira K, Yeva)"],
      ["\u2716\uFE0F Marko"],
      ["\u2B05\uFE0F Back"],
    ]);
    expect(rows.map((r) => r[0]?.data)).toEqual([
      "s:4:rt:28b125b6",
      "s:4:rt:d57631dd",
      "s:4:card",
    ]);
  });
});

describe("archiveConfirmMessage", () => {
  test("names what is detached and offers Back", () => {
    const card = {
      id: 4,
      name: "Yeva",
      calendarNames: [
        { title: "Duo B2/C1 (Mira K, Yeva)", titleKey: "k1", sharedWith: ["Mira K"] },
        { title: "Yeva", titleKey: "yeva", sharedWith: [] },
      ],
    } as StudentCard;
    expect(archiveConfirmMessage(card)).toEqual({
      text: "Archive Yeva? This detaches their calendar names: Duo B2/C1 (Mira K, Yeva), Yeva. Unarchiving does not bring them back.",
      buttons: [
        [{ text: "\u{1F5C4} Archive and detach", data: "s:4:archive!" }],
        [{ text: "\u2B05\uFE0F Back", data: "s:4:card" }],
      ],
    });
  });
});

describe("email and username rules", () => {
  test.each([
    [" A@B.C ", "a@b.c"],
    ["\tX@Y.Z\n", "x@y.z"],
  ])("normalizeEmail(%j)", (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  test.each([
    ["a@b.c", true],
    ["a".repeat(249) + "@b.cd", true],
    ["a@b", false],
    ["not-an-email", false],
    ["a b@c.d", false],
    ["a".repeat(250) + "@b.cd", false],
  ])("isValidEmail(%j) is %s", (input, expected) => {
    expect(isValidEmail(input)).toBe(expected);
  });

  test.each([
    [" - ", { username: null }],
    ["@Olena_K2", { username: "Olena_K2" }],
    ["abcd", { username: "abcd" }],
    ["a" + "b".repeat(31), { username: "a" + "b".repeat(31) }],
    ["abc", null],
    ["1abcd", null],
    ["a".repeat(33), null],
    ["@@x", null],
    ["has space", null],
  ])("parseUsername(%j)", (input, expected) => {
    expect(parseUsername(input)).toEqual(expected);
  });
});
