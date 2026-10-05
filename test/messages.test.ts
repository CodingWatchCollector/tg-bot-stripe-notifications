import { describe, expect, test } from "vitest";
import {
  assignedText,
  customerLine,
  dashboardLink,
  dismissedText,
  formatAmount,
  knownPayerText,
  newStudentPrompt,
  pickerButtons,
  studentsText,
  unknownPayerText,
  type PaymentFacts,
} from "../src/app/messages";
import { compareNames, isValidName, nameKey, normalizeName, type Student } from "../src/domain/student";

const base: PaymentFacts = {
  amountMinor: 16000,
  currency: "eur",
  customerName: "Anna K",
  customerEmail: "anna@example.com",
  paymentIntentId: "pi_123",
  livemode: true,
};
const LINK = "https://dashboard.stripe.com/payments/pi_123";

const student = (id: number, name: string): Student => ({
  id,
  name,
  nameKey: nameKey(name),
  telegramUsername: null,
  archived: false,
  createdAt: "t",
});

describe("formatAmount", () => {
  test("two decimals", () => expect(formatAmount(16000, "eur")).toBe("160.00 EUR"));
  test.each("bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf".split(" "))("zero-decimal %s", (code) => {
    expect(formatAmount(5000, code)).toBe(`5000 ${code.toUpperCase()}`);
  });
  test.each("bhd jod kwd omr tnd".split(" "))("three-decimal %s", (code) => {
    expect(formatAmount(12345, code)).toBe(`12.345 ${code.toUpperCase()}`);
  });
  test.each("huf isk twd eur usd".split(" "))("two-decimal %s", (code) => {
    expect(formatAmount(100000, code)).toBe(`1000.00 ${code.toUpperCase()}`);
  });
  test("unknown amount", () => expect(formatAmount(null, "eur")).toBe("amount unknown"));
  test("unknown currency", () => expect(formatAmount(4500, null)).toBe("amount unknown"));
});

describe("dashboardLink", () => {
  test("live", () => expect(dashboardLink("pi_123", true)).toBe(LINK));
  test("test mode", () => {
    expect(dashboardLink("pi_123", false)).toBe("https://dashboard.stripe.com/test/payments/pi_123");
  });
  test("no payment intent", () => expect(dashboardLink(null, true)).toBeNull());
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
    expect(knownPayerText("Olena", base)).toBe(`💶 Olena paid 160.00 EUR\n${LINK}`);
  });

  test("link line is omitted without a payment intent", () => {
    expect(knownPayerText("Olena", { ...base, paymentIntentId: null })).toBe("💶 Olena paid 160.00 EUR");
  });

  test("unknown payer", () => {
    expect(unknownPayerText(base)).toBe(`💶 Unknown payer paid 160.00 EUR\nAnna K <anna@example.com>\nWho is this?\n${LINK}`);
  });

  test("unknown amount in a template", () => {
    expect(knownPayerText("Olena", { ...base, amountMinor: null })).toBe(`💶 Olena paid amount unknown\n${LINK}`);
  });

  test("assigned with a saved email", () => {
    expect(assignedText("Ira + Pasha", base, "saved")).toBe(
      `💶 Ira + Pasha paid 160.00 EUR\nanna@example.com saved as Ira + Pasha's email\n${LINK}`,
    );
  });

  test("assigned with an email owned by another student", () => {
    expect(assignedText("Ira + Pasha", base, { ownedBy: { name: "Olena" } })).toBe(
      `💶 Ira + Pasha paid 160.00 EUR\nanna@example.com already belongs to Olena\n${LINK}`,
    );
  });

  test.each([["none" as const], ["saved" as const]])("assigned without an email has no second line (%s)", (outcome) => {
    expect(assignedText("Ira", { ...base, customerEmail: null }, outcome)).toBe(`💶 Ira paid 160.00 EUR\n${LINK}`);
  });

  test("assigned, nothing to report", () => {
    expect(assignedText("Ira", base)).toBe(`💶 Ira paid 160.00 EUR\n${LINK}`);
  });

  test("dismissed", () => {
    expect(dismissedText(base)).toBe(`💶 Payment dismissed: 160.00 EUR\nAnna K <anna@example.com>\n${LINK}`);
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

  test("callback data stays within 64 bytes", () => {
    const rows = pickerButtons(123456789, [student(987654321, "Olena")], "Olena");
    for (const b of rows.flat()) expect(new TextEncoder().encode(b.data).length).toBeLessThanOrEqual(64);
  });
});

describe("command replies", () => {
  test("students list", () => {
    expect(studentsText([student(1, "Olena"), student(2, "ira + pasha 2"), student(3, "Ira + Pasha")])).toBe(
      "Students (3):\nIra + Pasha\nira + pasha 2\nOlena",
    );
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
