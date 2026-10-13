import { beforeEach, describe, expect, test, vi } from "vitest";
import { createStore, attachTitleStatement, type Store } from "../src/db/store";
import { classifyOccurrence, titleKey } from "../src/domain/calendar";
import { createD1Fake, type D1Fake } from "./support/d1";
import { PRODUCTS_FIXTURE, addAdjustment, addCalendarName, addIgnoredTitle, addStudent, payment } from "./support/seed";

let fake: D1Fake;
let store: Store;
beforeEach(() => {
  fake = createD1Fake();
  store = createStore(fake.d1);
});

const rows = (sql: string) => fake.raw.all(sql);
const count = (table: string) => rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n;
const pack = PRODUCTS_FIXTURE.plink_t4!;
const club = PRODUCTS_FIXTURE.plink_club!;
const balances = async () => Object.fromEntries((await store.listStudentBalances()).map((b) => [b.name, b.balance]));
const sqlOf = (batch: { mock: { calls: unknown[][] } }, call = 0) => (batch.mock.calls[call]?.[0] as { sql: string }[]).map((s) => s.sql);
const rejects = (sql: string, ...params: (string | number | null)[]) => expect(() => fake.raw.run(sql, ...params)).toThrow();

describe("schema constraints", () => {
  const student = (name = "A", key = "a") =>
    fake.raw.run("INSERT INTO students(name, name_key, created_at) VALUES (?1, ?2, 't')", name, key);
  const pay = (cols: string, ...params: (string | number | null)[]) =>
    fake.raw.run(`INSERT INTO payments(${cols}, created_at) VALUES (${params.map((_, i) => `?${i + 1}`).join(",")}, 't')`, ...params);

  test("unique checkout session id", () => {
    pay("checkout_session_id, status", "cs", "unassigned");
    rejects("INSERT INTO payments(checkout_session_id, status, created_at) VALUES ('cs','unassigned','t')");
  });

  test("one row per payer email", () => {
    student();
    fake.raw.run("INSERT INTO payer_emails(email, student_id) VALUES ('a@x.com', 1)");
    rejects("INSERT INTO payer_emails(email, student_id) VALUES ('a@x.com', 1)");
  });

  test("one student per name_key", () => {
    student("A", "a");
    rejects("INSERT INTO students(name, name_key, created_at) VALUES ('a', 'a', 't')");
  });

  test("status and student must agree", () => {
    student();
    rejects("INSERT INTO payments(checkout_session_id, status, created_at) VALUES ('c1','assigned','t')");
    rejects("INSERT INTO payments(checkout_session_id, status, student_id, created_at) VALUES ('c2','unassigned',1,'t')");
    rejects("INSERT INTO payments(checkout_session_id, status, student_id, created_at) VALUES ('c3','dismissed',1,'t')");
  });

  test("status outside the three values", () => {
    rejects("INSERT INTO payments(checkout_session_id, status, created_at) VALUES ('c','paid','t')");
  });

  test("archived is 0/1", () => {
    rejects("INSERT INTO students(name, name_key, archived, created_at) VALUES ('A','a',2,'t')");
  });

  test("student references must exist", () => {
    rejects("INSERT INTO payer_emails(email, student_id) VALUES ('a@x.com', 99)");
    rejects("INSERT INTO payments(checkout_session_id, status, student_id, created_at) VALUES ('c','assigned',99,'t')");
  });

  test.each([
    ["students.name", "INSERT INTO students(name_key, created_at) VALUES ('a','t')"],
    ["students.name_key", "INSERT INTO students(name, created_at) VALUES ('A','t')"],
    ["students.created_at", "INSERT INTO students(name, name_key) VALUES ('A','a')"],
    ["payer_emails.student_id", "INSERT INTO payer_emails(email) VALUES ('a@x.com')"],
    ["payments.checkout_session_id", "INSERT INTO payments(status, created_at) VALUES ('unassigned','t')"],
    ["payments.status", "INSERT INTO payments(checkout_session_id, created_at) VALUES ('c','t')"],
    ["payments.created_at", "INSERT INTO payments(checkout_session_id, status) VALUES ('c','unassigned')"],
  ])("NOT NULL %s", (_col, sql) => {
    rejects(sql);
  });
});

describe("fake atomicity", () => {
  test("a failing second statement rolls back the first", async () => {
    addStudent(fake, "Olena");
    const ins = (name: string, key: string) =>
      fake.d1.prepare("INSERT INTO students(name, name_key, created_at) VALUES (?1, ?2, 't')").bind(name, key);
    await expect(fake.d1.batch([ins("New", "new"), ins("Olena 2", "olena")])).rejects.toThrow();
    expect(rows("SELECT name FROM students")).toEqual([{ name: "Olena" }]);
  });

  test("production code cannot open transactions", async () => {
    await expect(fake.d1.prepare("BEGIN").run()).rejects.toThrow();
  });
});

describe("recordPayment", () => {
  test("stores an unmatched payment as unassigned with all fields", async () => {
    const view = await store.recordPayment(payment({ paymentLinkId: "plink_1" }), null);
    expect(view).toMatchObject({
      checkoutSessionId: "cs_1",
      status: "unassigned",
      studentId: null,
      studentName: null,
      amountMinor: 16000,
      currency: "eur",
      customerName: "Anna K",
      customerEmail: "anna@example.com",
      paymentIntentId: "pi_123",
      paymentLinkId: "plink_1",
      messageId: null,
      notifiedAt: null,
    });
    expect(rows("SELECT payment_link_id FROM payments")).toEqual([{ payment_link_id: "plink_1" }]);
  });

  test("stores a null payment link as null", async () => {
    await store.recordPayment(payment(), null);
    expect(rows("SELECT payment_link_id FROM payments")).toEqual([{ payment_link_id: null }]);
  });

  test("a matched payment is assigned", async () => {
    const id = addStudent(fake, "Olena", { emails: ["o@x.com"] });
    const olena = await store.findStudentByEmail("o@x.com");
    const view = await store.recordPayment(payment({ customerEmail: "o@x.com" }), olena);
    expect(view).toMatchObject({ status: "assigned", studentId: id, studentName: "Olena" });
  });

  test("the same session twice keeps one row and the first decision", async () => {
    const id = addStudent(fake, "Olena", { emails: ["o@x.com"] });
    const first = await store.recordPayment(payment(), null);
    const olena = await store.findStudentByEmail("o@x.com");
    const second = await store.recordPayment(payment(), olena);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("unassigned");
    expect(count("payments")).toBe(1);
    expect(id).toBeGreaterThan(0);
  });

  test("the stored payment view has no mode flag", async () => {
    const view = await store.recordPayment(payment(), null);
    expect(view).not.toHaveProperty("livemode");
  });

  test("stores the Credit and the product name of a Pack", async () => {
    const view = await store.recordPayment(payment(), null, pack);
    expect(view).toMatchObject({ lessons: 4, productName: "Індивідуальний пакет 4" });
    expect(rows("SELECT lessons, product_name FROM payments")).toEqual([{ lessons: 4, product_name: "Індивідуальний пакет 4" }]);
  });

  test("a name-only product stores lessons 0, an unlisted one a null name", async () => {
    await store.recordPayment(payment({}, "cs_club"), null, club);
    await store.recordPayment(payment({}, "cs_none"), null, null);
    expect(rows("SELECT lessons, product_name FROM payments ORDER BY id")).toEqual([
      { lessons: 0, product_name: "Клуб B2/C1 — поурочно" },
      { lessons: 0, product_name: null },
    ]);
  });

  test("the same session recorded again keeps its first Credit and product name", async () => {
    addStudent(fake, "Olena", { emails: ["o@x.com"] });
    const student = await store.findStudentByEmail("o@x.com");
    await store.recordPayment(payment(), student, pack);
    const again = await store.recordPayment(payment(), student, { name: "X", lessons: 8 });
    expect(again).toMatchObject({ lessons: 4, productName: "Індивідуальний пакет 4", unarchived: false });
    expect(rows("SELECT lessons, product_name FROM payments")).toEqual([{ lessons: 4, product_name: "Індивідуальний пакет 4" }]);
    expect((await balances()).Olena).toBe(4);
  });

  describe("unarchive on payment", () => {
    let oldOne: number;
    beforeEach(() => {
      oldOne = addStudent(fake, "Old One", { emails: ["old@x.com"], archived: true });
    });
    const archivedFlag = () => rows(`SELECT archived FROM students WHERE id = ${oldOne}`);

    test("a Pack unarchives the Student in the same batch as the insert", async () => {
      const student = await store.findStudentByEmail("old@x.com");
      const batch = vi.spyOn(fake, "batch");
      const view = await store.recordPayment(payment(), student, pack);
      expect(view.unarchived).toBe(true);
      expect(archivedFlag()).toEqual([{ archived: 0 }]);
      expect(batch).toHaveBeenCalledTimes(1);
      const sql = sqlOf(batch);
      expect(sql).toHaveLength(2);
      expect(sql[0]).toContain("INSERT INTO payments");
      expect(sql[1]).toContain("UPDATE students SET archived = 0");
    });

    test("a name-only product leaves the Student archived [M3]", async () => {
      const student = await store.findStudentByEmail("old@x.com");
      const view = await store.recordPayment(payment(), student, club);
      expect(view.unarchived).toBe(false);
      expect(archivedFlag()).toEqual([{ archived: 1 }]);
    });

    test("an unlisted payment leaves the Student archived [M3]", async () => {
      const student = await store.findStudentByEmail("old@x.com");
      const view = await store.recordPayment(payment(), student, null);
      expect(view.unarchived).toBe(false);
      expect(archivedFlag()).toEqual([{ archived: 1 }]);
    });
  });
});

describe("adjustPayment", () => {
  const credited = async () => {
    const olena = addStudent(fake, "Olena", { emails: ["o@x.com"] });
    addAdjustment(fake, olena, 1);
    const student = await store.findStudentByEmail("o@x.com");
    const p = await store.recordPayment(payment(), student, pack);
    return { olena, p };
  };

  test("records a payment correction and returns the recomputed Payment", async () => {
    const { olena, p } = await credited();
    const out = await store.adjustPayment(p.id, 1);
    expect(out).toMatchObject({ kind: "adjusted", payment: { correction: 1, studentBalance: 6 } });
    expect(rows("SELECT student_id, delta, reason, payment_id FROM adjustments WHERE payment_id IS NOT NULL")).toEqual([
      { student_id: olena, delta: 1, reason: "payment correction", payment_id: p.id },
    ]);
    expect(rows("SELECT created_at FROM adjustments WHERE payment_id IS NOT NULL")[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("a payment that never existed is not found", async () => {
    expect(await store.adjustPayment(99, 1)).toEqual({ kind: "not_found" });
    expect(count("adjustments")).toBe(0);
  });

  test("an unassigned Pack is not found [M5]", async () => {
    const p = await store.recordPayment(payment(), null, pack);
    expect(await store.adjustPayment(p.id, 1)).toEqual({ kind: "not_found" });
    expect(count("adjustments")).toBe(0);
  });

  test("a dismissed Pack is not found [M5]", async () => {
    const p = await store.recordPayment(payment(), null, pack);
    await store.dismissPayment(p.id);
    expect(await store.adjustPayment(p.id, -1)).toEqual({ kind: "not_found" });
    expect(count("adjustments")).toBe(0);
  });

  test("an assigned name-only payment is not found [M4]", async () => {
    addStudent(fake, "Olena", { emails: ["o@x.com"] });
    const student = await store.findStudentByEmail("o@x.com");
    const p = await store.recordPayment(payment(), student, club);
    expect(await store.adjustPayment(p.id, 1)).toEqual({ kind: "not_found" });
    expect(count("adjustments")).toBe(0);
  });
});

describe("Balance", () => {
  test("Credits of assigned Packs plus Adjustments and corrections", async () => {
    const olena = addStudent(fake, "Olena", { emails: ["o@x.com"] });
    const student = await store.findStudentByEmail("o@x.com");
    const assigned = await store.recordPayment(payment({}, "cs_a"), student, pack);
    await store.recordPayment(payment({}, "cs_b"), student, club);
    await store.recordPayment(payment({}, "cs_c"), null, pack);
    const dismissed = await store.recordPayment(payment({}, "cs_d"), null, pack);
    await store.dismissPayment(dismissed.id);
    addAdjustment(fake, olena, 1);
    addAdjustment(fake, olena, -3);
    addAdjustment(fake, olena, 1, "payment correction", assigned.id);

    expect((await balances()).Olena).toBe(3);
    expect(await store.getPayment(assigned.id)).toMatchObject({
      lessons: 4,
      productName: "Індивідуальний пакет 4",
      correction: 1,
      studentBalance: 3,
    });
    expect(await store.getPayment(dismissed.id)).toMatchObject({ studentBalance: null, correction: 0 });
    expect((await store.getPayment(3))?.studentBalance).toBeNull();
  });

  test("negative Balances are allowed", async () => {
    addAdjustment(fake, addStudent(fake, "Olena"), -2);
    expect((await balances()).Olena).toBe(-2);
  });

  test("a Student without activity has Balance 0 and archived Students are not listed", async () => {
    addStudent(fake, "Olena");
    addStudent(fake, "Old One", { archived: true });
    expect(await balances()).toEqual({ Olena: 0 });
  });

  test("a correction of another Student does not count for this Payment [M7]", async () => {
    const olena = addStudent(fake, "Olena", { emails: ["o@x.com"] });
    const ira = addStudent(fake, "Ira + Pasha");
    const student = await store.findStudentByEmail("o@x.com");
    const assigned = await store.recordPayment(payment(), student, pack);
    addAdjustment(fake, olena, 1, "payment correction", assigned.id);
    addAdjustment(fake, ira, 5, "stray", assigned.id);
    expect((await store.getPayment(assigned.id))?.correction).toBe(1);
    expect((await balances())["Ira + Pasha"]).toBe(5);
  });
});

describe("adjustStudent", () => {
  test("adds the Adjustment and reports the Balances without unarchiving an active Student [M8]", async () => {
    const olena = addStudent(fake, "Olena");
    addAdjustment(fake, olena, 2);
    const out = await store.adjustStudent(olena, -3, "refund");
    expect(out).toMatchObject({ kind: "adjusted", student: { id: olena, name: "Olena", archived: false }, before: 2, after: -1, unarchived: false });
    expect(rows("SELECT student_id, delta, reason, payment_id FROM adjustments WHERE reason = 'refund'")).toEqual([
      { student_id: olena, delta: -3, reason: "refund", payment_id: null },
    ]);
    expect(rows("SELECT created_at FROM adjustments WHERE reason = 'refund'")[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("an archived Student is unarchived in the same batch as the Adjustment", async () => {
    const oldOne = addStudent(fake, "Old One", { archived: true });
    const batch = vi.spyOn(fake, "batch");
    const out = await store.adjustStudent(oldOne, 2, "back");
    expect(out).toMatchObject({ kind: "adjusted", student: { id: oldOne, archived: false }, before: 0, after: 2, unarchived: true });
    expect(batch).toHaveBeenCalledTimes(1);
    const sql = sqlOf(batch);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain("INSERT INTO adjustments");
    expect(sql[1]).toContain("UPDATE students SET archived = 0");
    expect(rows(`SELECT archived FROM students WHERE id = ${oldOne}`)).toEqual([{ archived: 0 }]);
  });

  test("an id that never existed is not found and writes nothing [M6]", async () => {
    addStudent(fake, "Olena");
    expect(await store.adjustStudent(99, 1, "x")).toEqual({ kind: "not_found" });
    expect(count("adjustments")).toBe(0);
    expect(rows("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
  });
});

describe("listStudentBalances", () => {
  test("lists active Students with their Balance", async () => {
    const olena = addStudent(fake, "Olena");
    addAdjustment(fake, olena, 5);
    expect(await store.listStudentBalances()).toEqual([{ id: olena, name: "Olena", balance: 5 }]);
  });
});

describe("lookups", () => {
  test("findStudentByEmail matches archived students", async () => {
    const id = addStudent(fake, "Old One", { emails: ["old@x.com"], archived: true });
    expect(await store.findStudentByEmail("old@x.com")).toMatchObject({ id, name: "Old One", archived: true });
    expect(await store.findStudentByEmail("nobody@x.com")).toBeNull();
  });

  test("listActiveStudents hides archived", async () => {
    addStudent(fake, "Olena");
    addStudent(fake, "Old One", { archived: true });
    expect((await store.listActiveStudents()).map((s) => s.name)).toEqual(["Olena"]);
  });

  test("findStudentByNameKey finds any student", async () => {
    addStudent(fake, "Old One", { archived: true });
    expect((await store.findStudentByNameKey("old one"))?.name).toBe("Old One");
    expect(await store.findStudentByNameKey("x")).toBeNull();
  });

  test("getPayment returns null for an unknown id", async () => {
    expect(await store.getPayment(99)).toBeNull();
  });
});

describe("markNotified", () => {
  test("sets message id and notified_at", async () => {
    const view = await store.recordPayment(payment(), null);
    await store.markNotified(view.id, 55);
    const after = await store.getPayment(view.id);
    expect(after?.messageId).toBe(55);
    expect(after?.notifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("assignPayment", () => {
  test("assigns and saves the email", async () => {
    const sid = addStudent(fake, "Ira + Pasha");
    const p = await store.recordPayment(payment(), null);
    const out = await store.assignPayment(p.id, sid);
    expect(out).toMatchObject({ kind: "assigned", email: "saved", payment: { status: "assigned", studentName: "Ira + Pasha" } });
    expect(rows("SELECT email, student_id FROM payer_emails")).toEqual([{ email: "anna@example.com", student_id: sid }]);
  });

  test("a payment without email saves none", async () => {
    const sid = addStudent(fake, "Ira");
    const p = await store.recordPayment(payment({ customerEmail: null }), null);
    expect(await store.assignPayment(p.id, sid)).toMatchObject({ kind: "assigned", email: "none" });
    expect(count("payer_emails")).toBe(0);
  });

  test("an email the student already owns reports none", async () => {
    const sid = addStudent(fake, "Ira", { emails: ["anna@example.com"] });
    const p = await store.recordPayment(payment(), null);
    expect(await store.assignPayment(p.id, sid)).toMatchObject({ kind: "assigned", email: "none" });
  });

  test("an email owned by another student stays with the owner", async () => {
    const olena = addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const ira = addStudent(fake, "Ira");
    const p = await store.recordPayment(payment(), null);
    const out = await store.assignPayment(p.id, ira);
    expect(out).toMatchObject({ kind: "assigned", payment: { studentId: ira } });
    expect(out.kind === "assigned" && out.email).toMatchObject({ ownedBy: { name: "Olena" } });
    expect(rows("SELECT student_id FROM payer_emails")).toEqual([{ student_id: olena }]);
  });

  test("a resolved payment saves no email and is reported", async () => {
    const ira = addStudent(fake, "Ira");
    const p = await store.recordPayment(payment(), null);
    await store.dismissPayment(p.id);
    const out = await store.assignPayment(p.id, ira);
    expect(out).toMatchObject({ kind: "already_resolved", payment: { status: "dismissed" } });
    expect(count("payer_emails")).toBe(0);
  });

  test("unknown payment or student", async () => {
    const p = await store.recordPayment(payment(), null);
    expect(await store.assignPayment(99, 1)).toEqual({ kind: "not_found" });
    expect(await store.assignPayment(p.id, 99)).toEqual({ kind: "not_found" });
    expect((await store.getPayment(p.id))?.status).toBe("unassigned");
  });
});

describe("assignPayment unarchive", () => {
  test("a Pack assigned to an archived Student unarchives them in the same batch", async () => {
    const marta = addStudent(fake, "Marta", { archived: true });
    const p = await store.recordPayment(payment(), null, pack);
    const batch = vi.spyOn(fake, "batch");
    const out = await store.assignPayment(p.id, marta);
    expect(out).toMatchObject({ kind: "assigned", unarchived: true });
    expect(batch).toHaveBeenCalledTimes(1);
    const sql = sqlOf(batch);
    expect(sql[0]).toContain("UPDATE payments SET status = 'assigned'");
    expect(sql.at(-1)).toContain("UPDATE students SET archived = 0");
    expect(await balances()).toEqual({ Marta: 4 });
  });

  test("a Pack assigned to an active Student unarchives nobody", async () => {
    const marta = addStudent(fake, "Marta");
    const p = await store.recordPayment(payment(), null, pack);
    expect(await store.assignPayment(p.id, marta)).toMatchObject({ kind: "assigned", unarchived: false });
  });

  test("a name-only payment leaves an archived Student archived [M10]", async () => {
    const marta = addStudent(fake, "Marta", { archived: true });
    const p = await store.recordPayment(payment(), null, club);
    expect(await store.assignPayment(p.id, marta)).toMatchObject({ kind: "assigned", unarchived: false });
    expect(rows(`SELECT archived FROM students WHERE id = ${marta}`)).toEqual([{ archived: 1 }]);
  });

  test("createStudentAndAssign on a Pack reports no unarchive and the new Student is active", async () => {
    const p = await store.recordPayment(payment(), null, pack);
    expect(await store.createStudentAndAssign(p.id, "Marie Curie")).toMatchObject({ kind: "assigned", unarchived: false });
    expect(rows("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
    expect(await balances()).toEqual({ "Marie Curie": 4 });
  });
});

describe("createStudentAndAssign", () => {
  test("creates the student, assigns, saves the email", async () => {
    const p = await store.recordPayment(payment(), null);
    const out = await store.createStudentAndAssign(p.id, "Marie Curie");
    expect(out).toMatchObject({ kind: "assigned", email: "saved", payment: { status: "assigned", studentName: "Marie Curie" } });
    expect(rows("SELECT name, name_key, archived FROM students")).toEqual([{ name: "Marie Curie", name_key: "marie curie", archived: 0 }]);
    expect(rows("SELECT email FROM payer_emails")).toEqual([{ email: "anna@example.com" }]);
  });

  test("a resolved payment creates no student", async () => {
    const p = await store.recordPayment(payment(), null);
    await store.dismissPayment(p.id);
    const out = await store.createStudentAndAssign(p.id, "Marie Curie");
    expect(out.kind).toBe("already_resolved");
    expect(count("students")).toBe(0);
  });

  test("a resolved payment assigned to the same-named student saves no email", async () => {
    const sid = addStudent(fake, "Marie Curie");
    const p = await store.recordPayment(payment(), null);
    await store.assignPayment(p.id, sid);
    fake.raw.run("DELETE FROM payer_emails");
    const out = await store.createStudentAndAssign(p.id, "marie curie");
    expect(out.kind).toBe("already_resolved");
    expect(count("payer_emails")).toBe(0);
  });

  test("a taken name creates nothing and never assigns to the existing student", async () => {
    addStudent(fake, "Marie Curie");
    const p = await store.recordPayment(payment(), null);
    const out = await store.createStudentAndAssign(p.id, "marie  curie");
    expect(out).toMatchObject({ kind: "name_taken", existing: { name: "Marie Curie" } });
    expect(count("students")).toBe(1);
    expect((await store.getPayment(p.id))?.status).toBe("unassigned");
    expect(count("payer_emails")).toBe(0);
  });

  test("a successful create reads the payment twice", async () => {
    const p = await store.recordPayment(payment(), null);
    const prepare = vi.spyOn(fake, "prepare");
    const out = await store.createStudentAndAssign(p.id, "Marie Curie");
    expect(out.kind).toBe("assigned");
    const reads = prepare.mock.calls.filter(([sql]) => sql.includes("FROM payments p LEFT JOIN students"));
    expect(reads).toHaveLength(2);
  });

  test("unknown payment", async () => {
    expect(await store.createStudentAndAssign(99, "X")).toEqual({ kind: "not_found" });
    expect(count("students")).toBe(0);
  });

  test("an email owned by someone else stays with the owner", async () => {
    addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const p = await store.recordPayment(payment(), null);
    const out = await store.createStudentAndAssign(p.id, "Marie Curie");
    expect(out.kind === "assigned" && out.email).toMatchObject({ ownedBy: { name: "Olena" } });
    expect(rows("SELECT COUNT(*) AS n FROM payer_emails WHERE email = 'anna@example.com'")).toEqual([{ n: 1 }]);
  });
});

describe("dismissPayment", () => {
  test("dismisses an unassigned payment once and returns the dismissed row", async () => {
    const p = await store.recordPayment(payment(), null);
    expect(await store.dismissPayment(p.id)).toMatchObject({ kind: "dismissed", payment: { id: p.id, status: "dismissed" } });
    expect((await store.getPayment(p.id))?.status).toBe("dismissed");
    expect(await store.dismissPayment(p.id)).toMatchObject({ kind: "already_resolved", payment: { status: "dismissed" } });
    expect(await store.dismissPayment(99)).toEqual({ kind: "not_found" });
    expect(count("payer_emails")).toBe(0);
  });
});

describe("lost races", () => {
  const hook = (sql: string, ...params: (string | number)[]) => {
    let ran = 0;
    fake.beforeNextBatch(() => {
      ran++;
      fake.raw.run(sql, ...params);
    });
    return () => ran;
  };
  const dismissRow = "UPDATE payments SET status = 'dismissed' WHERE id = ?1";
  const paymentRow = () => rows("SELECT status, student_id FROM payments");

  test("assignPayment loses to a dismiss", async () => {
    const sid = addStudent(fake, "Ira");
    const p = await store.recordPayment(payment(), null);
    const ran = hook(dismissRow, p.id);
    const out = await store.assignPayment(p.id, sid);
    expect(out).toMatchObject({ kind: "already_resolved", payment: { status: "dismissed", studentId: null } });
    expect(paymentRow()).toEqual([{ status: "dismissed", student_id: null }]);
    expect(count("payer_emails")).toBe(0);
    expect(ran()).toBe(1);
  });

  test("createStudentAndAssign loses to a dismiss and leaves no orphan student", async () => {
    const p = await store.recordPayment(payment(), null);
    const ran = hook(dismissRow, p.id);
    const out = await store.createStudentAndAssign(p.id, "Marie Curie");
    expect(out).toMatchObject({ kind: "already_resolved", payment: { status: "dismissed" } });
    expect(count("students")).toBe(0);
    expect(count("payer_emails")).toBe(0);
    expect(paymentRow()).toEqual([{ status: "dismissed", student_id: null }]);
    expect(ran()).toBe(1);
  });

  test("createStudentAndAssign loses the name to a concurrent insert", async () => {
    const p = await store.recordPayment(payment(), null);
    const ran = hook("INSERT INTO students(name, name_key, created_at) VALUES ('Marie Curie', 'marie curie', 't')");
    const out = await store.createStudentAndAssign(p.id, "marie  curie");
    expect(out).toMatchObject({ kind: "name_taken", existing: { name: "Marie Curie" } });
    expect(rows("SELECT name FROM students")).toEqual([{ name: "Marie Curie" }]);
    expect(paymentRow()).toEqual([{ status: "unassigned", student_id: null }]);
    expect(count("payer_emails")).toBe(0);
    expect(ran()).toBe(1);
  });

  test("dismissPayment loses to an assign", async () => {
    const sid = addStudent(fake, "Ira");
    const p = await store.recordPayment(payment(), null);
    const ran = hook("UPDATE payments SET status = 'assigned', student_id = ?2 WHERE id = ?1", p.id, sid);
    const out = await store.dismissPayment(p.id);
    expect(out).toMatchObject({ kind: "already_resolved", payment: { status: "assigned", studentId: sid } });
    expect(paymentRow()).toEqual([{ status: "assigned", student_id: sid }]);
    expect(ran()).toBe(1);
  });

  test("dismissPayment loses to another dismiss", async () => {
    const p = await store.recordPayment(payment(), null);
    const ran = hook(dismissRow, p.id);
    const out = await store.dismissPayment(p.id);
    expect(out).toMatchObject({ kind: "already_resolved", payment: { status: "dismissed" } });
    expect(ran()).toBe(1);
  });

  const archivedOf = (id: number) => rows(`SELECT archived FROM students WHERE id = ${id}`);

  describe("recordPayment", () => {
    let oldOne: number;
    beforeEach(() => {
      oldOne = addStudent(fake, "Old One", { emails: ["old@example.com"], archived: true });
    });

    test("skips the unarchive when the session was already notified [M1]", async () => {
      const preRead = await store.findStudentByEmail("old@example.com");
      const ran = hook(
        "INSERT INTO payments(checkout_session_id, status, student_id, lessons, notified_at, created_at) VALUES ('cs_1', 'assigned', ?1, 4, 'n', 't')",
        oldOne,
      );
      const view = await store.recordPayment(payment(), preRead, pack);
      expect(view.notifiedAt).not.toBeNull();
      expect(view.unarchived).toBe(false);
      expect(archivedOf(oldOne)).toEqual([{ archived: 1 }]);
      expect(count("payments")).toBe(1);
      expect(ran()).toBe(1);
    });

    test("reports no unarchive when the Student became active meanwhile [M2]", async () => {
      const preRead = await store.findStudentByEmail("old@example.com");
      const ran = hook("UPDATE students SET archived = 0 WHERE id = ?1", oldOne);
      const view = await store.recordPayment(payment(), preRead, pack);
      expect(view).toMatchObject({ status: "assigned", lessons: 4, unarchived: false });
      expect(archivedOf(oldOne)).toEqual([{ archived: 0 }]);
      expect(ran()).toBe(1);
    });

    test("leaves the Student archived when the session was recorded unassigned meanwhile", async () => {
      const preRead = await store.findStudentByEmail("old@example.com");
      const ran = hook("INSERT INTO payments(checkout_session_id, status, created_at) VALUES ('cs_1', 'unassigned', 't')");
      const view = await store.recordPayment(payment(), preRead, pack);
      expect(view).toMatchObject({ status: "unassigned", unarchived: false });
      expect(archivedOf(oldOne)).toEqual([{ archived: 1 }]);
      expect(ran()).toBe(1);
    });
  });

  test("assignPayment of a Pack loses to a dismiss and credits nothing", async () => {
    const ira = addStudent(fake, "Ira");
    const p = await store.recordPayment(payment(), null, pack);
    const ran = hook("UPDATE payments SET status = 'dismissed' WHERE id = ?1", p.id);
    const out = await store.assignPayment(p.id, ira);
    expect(out).toMatchObject({ kind: "already_resolved", payment: { status: "dismissed" } });
    expect(rows("SELECT status, student_id, lessons FROM payments")).toEqual([{ status: "dismissed", student_id: null, lessons: 4 }]);
    expect((await balances()).Ira).toBe(0);
    expect(ran()).toBe(1);
  });

  describe("assignPayment unarchive", () => {
    test("unarchives a Student archived after the pre-read", async () => {
      const marta = addStudent(fake, "Marta");
      const p = await store.recordPayment(payment(), null, pack);
      const ran = hook("UPDATE students SET archived = 1 WHERE id = ?1", marta);
      expect(await store.assignPayment(p.id, marta)).toMatchObject({ kind: "assigned", unarchived: true });
      expect(archivedOf(marta)).toEqual([{ archived: 0 }]);
      expect(rows("SELECT status, student_id FROM payments")).toEqual([{ status: "assigned", student_id: marta }]);
      expect(ran()).toBe(1);
    });

    test("reports no unarchive when the Student became active after the pre-read [M9]", async () => {
      const marta = addStudent(fake, "Marta", { archived: true });
      const p = await store.recordPayment(payment(), null, pack);
      const ran = hook("UPDATE students SET archived = 0 WHERE id = ?1", marta);
      expect(await store.assignPayment(p.id, marta)).toMatchObject({ kind: "assigned", unarchived: false });
      expect(archivedOf(marta)).toEqual([{ archived: 0 }]);
      expect(ran()).toBe(1);
    });

    test("leaves the Student archived when the Pack was dismissed after the pre-read [M11]", async () => {
      const marta = addStudent(fake, "Marta", { archived: true });
      const p = await store.recordPayment(payment(), null, pack);
      const ran = hook("UPDATE payments SET status = 'dismissed' WHERE id = ?1", p.id);
      expect(await store.assignPayment(p.id, marta)).toMatchObject({ kind: "already_resolved", payment: { status: "dismissed" } });
      expect(archivedOf(marta)).toEqual([{ archived: 1 }]);
      expect(count("payer_emails")).toBe(0);
      expect(ran()).toBe(1);
    });
  });

  test("renameStudent loses the name to a concurrent insert [C4]", async () => {
    const olena = addStudent(fake, "Olena");
    const ran = hook("INSERT INTO students(name, name_key, created_at) VALUES ('Olena K', 'olena k', 't')");
    const out = await store.renameStudent(olena, "Olena K");
    expect(out).toMatchObject({ kind: "name_taken", existing: { name: "Olena K" } });
    expect(rows("SELECT name FROM students ORDER BY id")).toEqual([{ name: "Olena" }, { name: "Olena K" }]);
    expect(ran()).toBe(1);
  });

  describe("adjustStudent", () => {
    test("reports no unarchive when the Student became active after the lookup [M8]", async () => {
      const oldOne = addStudent(fake, "Old One", { archived: true });
      const looked = await store.findStudentByNameKey("old one");
      const ran = hook("UPDATE students SET archived = 0 WHERE id = ?1", oldOne);
      const out = await store.adjustStudent(looked!.id, 2, "x");
      expect(out).toMatchObject({ kind: "adjusted", unarchived: false });
      expect(count("adjustments")).toBe(1);
      expect(archivedOf(oldOne)).toEqual([{ archived: 0 }]);
      expect(ran()).toBe(1);
    });

    test("unarchives a Student archived after the lookup", async () => {
      const olena = addStudent(fake, "Olena");
      const looked = await store.findStudentByNameKey("olena");
      const ran = hook("UPDATE students SET archived = 1 WHERE id = ?1", olena);
      const out = await store.adjustStudent(looked!.id, 2, "x");
      expect(out).toMatchObject({ kind: "adjusted", unarchived: true });
      expect(count("adjustments")).toBe(1);
      expect(archivedOf(olena)).toEqual([{ archived: 0 }]);
      expect(ran()).toBe(1);
    });
  });
});

describe("renameStudent", () => {
  test("renames", async () => {
    const id = addStudent(fake, "Olena");
    expect(await store.renameStudent(id, "Olena K")).toMatchObject({
      kind: "renamed",
      previousName: "Olena",
      card: { name: "Olena K", nameKey: "olena k" },
    });
    expect(rows("SELECT name, name_key FROM students")).toEqual([{ name: "Olena K", name_key: "olena k" }]);
  });

  test("changing only the case succeeds", async () => {
    const id = addStudent(fake, "Olena");
    expect(await store.renameStudent(id, "OLENA")).toMatchObject({ kind: "renamed", previousName: "Olena", card: { name: "OLENA" } });
    expect(rows("SELECT name FROM students")).toEqual([{ name: "OLENA" }]);
  });

  test("a taken name is name_taken and both rows stay [C4]", async () => {
    const id = addStudent(fake, "Olena");
    addStudent(fake, "Ira");
    expect(await store.renameStudent(id, "ira")).toMatchObject({ kind: "name_taken", existing: { name: "Ira" } });
    expect(rows("SELECT name FROM students ORDER BY id")).toEqual([{ name: "Olena" }, { name: "Ira" }]);
  });

  test("unknown id", async () => {
    expect(await store.renameStudent(99, "X")).toEqual({ kind: "not_found" });
    expect(count("students")).toBe(0);
  });

  test("the outcome carries the full card", async () => {
    const olena = addStudent(fake, "Olena", { emails: ["olena@example.com"] });
    addAdjustment(fake, olena, 5);
    fake.raw.run("UPDATE students SET telegram_username = 'olena_k' WHERE id = ?1", olena);
    expect(await store.renameStudent(olena, "Olena K")).toEqual({
      kind: "renamed",
      previousName: "Olena",
      card: {
        id: olena,
        name: "Olena K",
        nameKey: "olena k",
        telegramUsername: "olena_k",
        archived: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        balance: 5,
        emails: ["olena@example.com"],
        calendarNames: [],
      },
    });
  });
});

describe("student card writes", () => {
  const cardOf = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    name: "Olena",
    nameKey: "olena",
    telegramUsername: null,
    archived: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    balance: 0,
    emails: [] as string[],
    calendarNames: [] as unknown[],
    ...over,
  });
  const emailRows = () => rows("SELECT email, student_id FROM payer_emails ORDER BY email");

  describe("getStudentCard and listStudentBalances", () => {
    test("a card has the Balance and the emails in ascending order", async () => {
      const olena = addStudent(fake, "Olena", { emails: ["olena@example.com", "o2@example.com"] });
      addAdjustment(fake, olena, 5);
      expect(await store.getStudentCard(olena)).toEqual(cardOf(olena, { balance: 5, emails: ["o2@example.com", "olena@example.com"] }));
      expect(await store.getStudentCard(99)).toBeNull();
    });

    test("an archived list holds only Archived Students", async () => {
      addStudent(fake, "Olena");
      const old = addStudent(fake, "Old One", { archived: true });
      addAdjustment(fake, old, 2);
      expect(await store.listStudentBalances(true)).toEqual([{ id: old, name: "Old One", balance: 2 }]);
      expect((await store.listStudentBalances()).map((s) => s.name)).toEqual(["Olena"]);
    });
  });

  describe("setArchived", () => {
    test("archives and unarchives, reporting the card", async () => {
      const olena = addStudent(fake, "Olena");
      expect(await store.setArchived(olena, true)).toEqual({ kind: "updated", card: cardOf(olena, { archived: true }), detached: [] });
      expect(await store.setArchived(olena, false)).toEqual({ kind: "updated", card: cardOf(olena), detached: [] });
      expect(rows("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
    });

    test("a second archive is already_resolved [C1]", async () => {
      const olena = addStudent(fake, "Olena");
      await store.setArchived(olena, true);
      expect(await store.setArchived(olena, true)).toEqual({ kind: "already_resolved", card: cardOf(olena, { archived: true }), detached: [] });
    });

    test("an unknown id is not_found", async () => {
      expect(await store.setArchived(99, true)).toEqual({ kind: "not_found" });
    });
  });

  describe("addEmail", () => {
    let olena: number;
    let ira: number;
    beforeEach(() => {
      olena = addStudent(fake, "Olena", { emails: ["olena@example.com"] });
      ira = addStudent(fake, "Ira", { emails: ["ira@example.com"] });
    });

    test("adds an email", async () => {
      expect(await store.addEmail(olena, "o3@example.com")).toEqual({
        kind: "added",
        card: cardOf(olena, { emails: ["o3@example.com", "olena@example.com"] }),
      });
      expect(emailRows()).toContainEqual({ email: "o3@example.com", student_id: olena });
    });

    test("an email already theirs is already_resolved", async () => {
      expect(await store.addEmail(olena, "olena@example.com")).toEqual({
        kind: "already_resolved",
        card: cardOf(olena, { emails: ["olena@example.com"] }),
      });
      expect(emailRows()).toHaveLength(2);
    });

    test("an email owned by Ira is email_taken and not moved [C3]", async () => {
      expect(await store.addEmail(olena, "ira@example.com")).toEqual({
        kind: "email_taken",
        owner: { id: ira, name: "Ira", nameKey: "ira", telegramUsername: null, archived: false, createdAt: "2026-10-01T00:00:00.000Z" },
      });
      expect(emailRows()).toContainEqual({ email: "ira@example.com", student_id: ira });
    });

    test("an unknown id is not_found and writes nothing [C5]", async () => {
      expect(await store.addEmail(99, "z@example.com")).toEqual({ kind: "not_found" });
      expect(emailRows().map((r) => r.email)).not.toContain("z@example.com");
    });
  });

  describe("removeEmail", () => {
    let olena: number;
    beforeEach(() => {
      olena = addStudent(fake, "Olena", { emails: ["olena@example.com"] });
    });

    test("removes the Student's own email", async () => {
      expect(await store.removeEmail(olena, "olena@example.com")).toEqual({ kind: "removed", card: cardOf(olena) });
      expect(emailRows()).toEqual([]);
    });

    test("another Student's email is already_resolved and kept [C2]", async () => {
      const ira = addStudent(fake, "Ira", { emails: ["ira@example.com"] });
      expect(await store.removeEmail(olena, "ira@example.com")).toEqual({
        kind: "already_resolved",
        card: cardOf(olena, { emails: ["olena@example.com"] }),
      });
      expect(emailRows()).toContainEqual({ email: "ira@example.com", student_id: ira });
    });

    test("an unknown id is not_found", async () => {
      expect(await store.removeEmail(99, "x@y.z")).toEqual({ kind: "not_found" });
    });
  });

  describe("setUsername", () => {
    test("sets and clears, keeping case", async () => {
      const olena = addStudent(fake, "Olena");
      expect(await store.setUsername(olena, "Olena_K2")).toEqual({ kind: "updated", card: cardOf(olena, { telegramUsername: "Olena_K2" }) });
      expect(rows("SELECT telegram_username FROM students")).toEqual([{ telegram_username: "Olena_K2" }]);
      expect(await store.setUsername(olena, null)).toEqual({ kind: "updated", card: cardOf(olena) });
      expect(rows("SELECT telegram_username FROM students")).toEqual([{ telegram_username: null }]);
    });

    test("an unknown id is not_found", async () => {
      expect(await store.setUsername(99, "abcd")).toEqual({ kind: "not_found" });
    });
  });
});

describe("Calendar names", () => {
  const DUO = "Duo B2/C1 (Mira K, Yeva)";
  const nameRows = () => rows("SELECT title_key, student_id, title FROM calendar_names ORDER BY title_key, student_id");
  const ignoredRows = () => rows("SELECT title_key, title FROM ignored_titles ORDER BY title_key");
  const titles = (card: { calendarNames: { title: string }[] } | null) => card?.calendarNames.map((n) => n.title);
  const inject = (sql: string, ...params: (string | number)[]) => fake.runBeforeNextBatch(sql, ...params);

  describe("attachTitleStatement", () => {
    test("[22b-M6] an ignored key is not attached when the statement runs alone", async () => {
      const marko = addStudent(fake, "Marko");
      addIgnoredTitle(fake, "Prep");
      const [out] = await fake.d1.batch([attachTitleStatement(fake.d1, marko, "prep", "t")]);
      expect(out?.results).toEqual([]);
      expect(nameRows()).toEqual([]);
      expect(ignoredRows()).toEqual([{ title_key: "prep", title: "Prep" }]);
    });

    test("without an ignored row it inserts and returns the key", async () => {
      const marko = addStudent(fake, "Marko");
      const [out] = await fake.d1.batch([attachTitleStatement(fake.d1, marko, "prep", "t")]);
      expect(out?.results).toEqual([{ title_key: titleKey("prep") }]);
      expect(nameRows()).toEqual([{ title_key: "prep", student_id: marko, title: "prep" }]);
    });
  });

  describe("addCalendarName", () => {
    test("stores the title under the classifier's key", async () => {
      const marko = addStudent(fake, "Marko");
      const out = await store.addCalendarName(marko, "  Duo   B2/C1  (Mira K, Yeva) ");
      expect(out).toMatchObject({ kind: "added", title: DUO, sharedWith: [], unignored: false });
      expect(nameRows()).toEqual([{ title_key: titleKey(DUO), student_id: marko, title: DUO }]);
      const sets = await store.getTitleSets();
      expect(classifyOccurrence({ title: "duo b2/c1 (mira k,  yeva)", allDay: false }, sets)).toEqual({
        kind: "lesson",
        titleKey: titleKey(DUO),
        studentIds: [marko],
      });
    });

    test("NFD input is stored as NFC and matches an NFC feed title", async () => {
      const taras = addStudent(fake, "Taras");
      const out = await store.addCalendarName(taras, "\u0406\u0308 Taras");
      expect(out).toMatchObject({ kind: "added", title: "\u0407 Taras" });
      expect(rows("SELECT title FROM calendar_names")).toEqual([{ title: "\u0407 Taras" }]);
      expect(classifyOccurrence({ title: "\u0407 Taras", allDay: false }, await store.getTitleSets())).toMatchObject({
        kind: "lesson",
        studentIds: [taras],
      });
    });

    test("a shared title lists the other Student on both cards", async () => {
      const miraK = addStudent(fake, "Mira K");
      const yeva = addStudent(fake, "Yeva");
      await store.addCalendarName(miraK, DUO);
      const out = await store.addCalendarName(yeva, "duo b2/c1 (mira k, yeva)");
      expect(out).toMatchObject({ kind: "added", title: "duo b2/c1 (mira k, yeva)", sharedWith: ["Mira K"] });
      expect(nameRows().map((r) => r.student_id)).toEqual([miraK, yeva]);
      expect((await store.getTitleSets()).attached.get(titleKey(DUO))).toEqual([miraK, yeva]);
      expect((await store.getStudentCard(miraK))?.calendarNames).toEqual([{ title: DUO, titleKey: titleKey(DUO), sharedWith: ["Yeva"] }]);
      expect((await store.getStudentCard(yeva))?.calendarNames).toEqual([
        { title: "duo b2/c1 (mira k, yeva)", titleKey: titleKey(DUO), sharedWith: ["Mira K"] },
      ]);
    });

    test("a title already attached is already_resolved with the stored spelling", async () => {
      const marko = addStudent(fake, "Marko");
      await store.addCalendarName(marko, "Marko");
      const before = nameRows();
      const out = await store.addCalendarName(marko, "MARKO");
      expect(out).toMatchObject({ kind: "already_resolved", title: "Marko" });
      expect(nameRows()).toEqual(before);
    });

    test("a blank title rejects and writes nothing", async () => {
      const marko = addStudent(fake, "Marko");
      await expect(store.addCalendarName(marko, "   ")).rejects.toThrow();
      expect(nameRows()).toEqual([]);
    });

    test("[22b-M1] an archived Student gets archived and nothing is written", async () => {
      const marko = addStudent(fake, "Marko", { archived: true });
      const out = await store.addCalendarName(marko, "Marko");
      expect(out).toMatchObject({ kind: "archived" });
      expect(nameRows()).toEqual([]);
    });

    test("an unknown id is not_found", async () => {
      expect(await store.addCalendarName(99, "Marko")).toEqual({ kind: "not_found" });
      expect(nameRows()).toEqual([]);
    });

    test("[22b-M1] a Student archived before the batch gets archived and no row", async () => {
      const marko = addStudent(fake, "Marko");
      const runs = inject("UPDATE students SET archived = 1 WHERE id = ?1", marko);
      const out = await store.addCalendarName(marko, "Marko");
      expect(runs.n).toBe(1);
      expect(out).toMatchObject({ kind: "archived" });
      expect(nameRows()).toEqual([]);
    });

    test("[22b-M5] an archived Student with an ignored key keeps the ignored row", async () => {
      const marko = addStudent(fake, "Marko", { archived: true });
      addIgnoredTitle(fake, "Prep");
      const out = await store.addCalendarName(marko, "prep");
      expect(out).toMatchObject({ kind: "archived" });
      expect(ignoredRows()).toEqual([{ title_key: "prep", title: "Prep" }]);
      expect(nameRows()).toEqual([]);
    });

    test("[22b-M2] attaching an ignored title un-ignores it", async () => {
      const marko = addStudent(fake, "Marko");
      addIgnoredTitle(fake, "Prep");
      const out = await store.addCalendarName(marko, "prep");
      expect(out).toMatchObject({ kind: "added", title: "prep", unignored: true });
      expect(ignoredRows()).toEqual([]);
      expect(nameRows()).toEqual([{ title_key: "prep", student_id: marko, title: "prep" }]);
      const sets = await store.getTitleSets();
      expect(sets.attached.get("prep")).toEqual([marko]);
      expect(sets.ignored.has("prep")).toBe(false);
    });

    test("without an ignored row unignored is false", async () => {
      const marko = addStudent(fake, "Marko");
      expect(await store.addCalendarName(marko, "Prep")).toMatchObject({ kind: "added", unignored: false });
    });

    test("[22b-M2] a title ignored just before the batch is still attached and un-ignored", async () => {
      const marko = addStudent(fake, "Marko");
      const runs = inject("INSERT INTO ignored_titles(title_key, title, created_at) VALUES ('prep', 'Prep', 't')");
      const out = await store.addCalendarName(marko, "Prep");
      expect(runs.n).toBe(1);
      expect(out).toMatchObject({ kind: "added", unignored: true });
      expect(ignoredRows()).toEqual([]);
      expect(nameRows()).toHaveLength(1);
    });

    test("the same row inserted before the batch is already_resolved with one row", async () => {
      const marko = addStudent(fake, "Marko");
      const runs = inject("INSERT INTO calendar_names(title_key, student_id, title, created_at) VALUES ('marko', ?1, 'Marko', 't')", marko);
      const out = await store.addCalendarName(marko, "Marko");
      expect(runs.n).toBe(1);
      expect(out).toMatchObject({ kind: "already_resolved", title: "Marko" });
      expect(nameRows()).toHaveLength(1);
    });
  });

  describe("removeCalendarName", () => {
    test("deletes only this Student's row and reports its stored spelling", async () => {
      const miraK = addStudent(fake, "Mira K");
      const yeva = addStudent(fake, "Yeva");
      addCalendarName(fake, yeva, "Yeva");
      addCalendarName(fake, miraK, DUO);
      addCalendarName(fake, yeva, "duo b2/c1 (mira k, yeva)");
      const out = await store.removeCalendarName(yeva, titleKey("Yeva"));
      expect(out).toMatchObject({ kind: "removed", title: "Yeva" });
      expect(titles(out.kind === "removed" ? out.card : null)).toEqual(["duo b2/c1 (mira k, yeva)"]);
      expect(nameRows().map((r) => r.student_id)).toEqual([miraK, yeva]);
      const again = await store.removeCalendarName(yeva, titleKey("Yeva"));
      expect(again).toMatchObject({ kind: "already_resolved" });
    });

    test("an unknown id is not_found", async () => {
      expect(await store.removeCalendarName(99, "x")).toEqual({ kind: "not_found" });
    });
  });

  describe("setArchived detaches", () => {
    test("[22b-M3] detaches only the archived Student's rows, sorted", async () => {
      const miraK = addStudent(fake, "Mira K");
      const yeva = addStudent(fake, "Yeva");
      addCalendarName(fake, yeva, "Yeva");
      addCalendarName(fake, yeva, DUO);
      addCalendarName(fake, miraK, DUO);
      const out = await store.setArchived(yeva, true);
      expect(out).toMatchObject({ kind: "updated", detached: [DUO, "Yeva"] });
      expect(nameRows()).toEqual([{ title_key: titleKey(DUO), student_id: miraK, title: DUO }]);
    });

    test("a Student without names reports nothing detached", async () => {
      const yeva = addStudent(fake, "Yeva");
      expect(await store.setArchived(yeva, true)).toMatchObject({ kind: "updated", detached: [] });
    });

    test("archiving an archived Student is already_resolved with nothing detached", async () => {
      const yeva = addStudent(fake, "Yeva", { archived: true });
      expect(await store.setArchived(yeva, true)).toMatchObject({ kind: "already_resolved", detached: [] });
    });

    test("a failing DELETE leaves the Student active with both rows", async () => {
      const yeva = addStudent(fake, "Yeva");
      addCalendarName(fake, yeva, "Yeva");
      addCalendarName(fake, yeva, DUO);
      fake.raw.run("CREATE TEMP TRIGGER fail_detach BEFORE DELETE ON calendar_names BEGIN SELECT RAISE(ABORT, 'injected'); END");
      await expect(store.setArchived(yeva, true)).rejects.toThrow(/injected/);
      expect(rows("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
      expect(nameRows()).toHaveLength(2);
    });

    test("a failing UPDATE keeps both rows", async () => {
      const yeva = addStudent(fake, "Yeva");
      addCalendarName(fake, yeva, "Yeva");
      addCalendarName(fake, yeva, DUO);
      fake.raw.run("CREATE TEMP TRIGGER fail_archive BEFORE UPDATE ON students BEGIN SELECT RAISE(ABORT, 'injected'); END");
      await expect(store.setArchived(yeva, true)).rejects.toThrow(/injected/);
      expect(rows("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
      expect(nameRows()).toHaveLength(2);
    });
  });

  describe("unarchive restores nothing", () => {
    let yeva: number;
    beforeEach(async () => {
      yeva = addStudent(fake, "Yeva");
      addCalendarName(fake, yeva, "Yeva");
      await store.setArchived(yeva, true);
    });

    const expectBare = async () => {
      expect((await store.getStudentCard(yeva))?.calendarNames).toEqual([]);
      expect([...(await store.getTitleSets()).attached.values()].flat()).not.toContain(yeva);
      expect(await store.addCalendarName(yeva, "Yeva")).toMatchObject({ kind: "added" });
    };

    test("setArchived(false)", async () => {
      await store.setArchived(yeva, false);
      await expectBare();
    });

    test("assignPayment of a Pack", async () => {
      const p = await store.recordPayment(payment({}, "cs_a"), null, pack);
      await store.assignPayment(p.id, yeva);
      expect(rows("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
      await expectBare();
    });

    test("recordPayment of a Pack matched to her", async () => {
      const archived = (await store.getStudentCard(yeva))!;
      await store.recordPayment(payment({}, "cs_b"), archived, pack);
      expect(rows("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
      await expectBare();
    });

    test("adjustStudent", async () => {
      await store.adjustStudent(yeva, 1, "-");
      expect(rows("SELECT archived FROM students")).toEqual([{ archived: 0 }]);
      await expectBare();
    });
  });

  describe("leftover rows of an archived Student", () => {
    let miraK: number;
    let yeva: number;
    beforeEach(() => {
      miraK = addStudent(fake, "Mira K");
      yeva = addStudent(fake, "Yeva", { archived: true });
      addCalendarName(fake, miraK, DUO);
      addCalendarName(fake, yeva, DUO);
      addCalendarName(fake, yeva, "Yeva");
      addIgnoredTitle(fake, "Prep");
      addIgnoredTitle(fake, "Taras morning");
    });

    test("[22b-M4] getTitleSets and sharedWith ignore them", async () => {
      const sets = await store.getTitleSets();
      expect([...sets.attached.values()].flat()).not.toContain(yeva);
      expect(sets.attached.get(titleKey(DUO))).toEqual([miraK]);
      expect(sets.attached.has(titleKey("Yeva"))).toBe(false);
      expect(sets.ignored).toEqual(new Set(["prep", "taras morning"]));
      expect((await store.getStudentCard(miraK))?.calendarNames).toEqual([{ title: DUO, titleKey: titleKey(DUO), sharedWith: [] }]);
    });

    test("the archived card lists them and archiving again removes them", async () => {
      expect(titles(await store.getStudentCard(yeva))).toEqual([DUO, "Yeva"]);
      const out = await store.setArchived(yeva, true);
      expect(out).toMatchObject({ kind: "already_resolved", detached: [DUO, "Yeva"] });
      expect(nameRows().map((r) => r.student_id)).toEqual([miraK]);
    });
  });

  test("names, sharedWith and detached use collator order, not insertion or binary order", async () => {
    const taras = addStudent(fake, "Taras");
    const miraK = addStudent(fake, "Mira K");
    const yeva = addStudent(fake, "Yeva");
    const D = "Duo C1 (Taras, Yeva, Mira K)";
    for (const t of ["Taras morning", "taras afternoon", "Taras evening"]) await store.addCalendarName(taras, t);
    await store.addCalendarName(taras, D);
    await store.addCalendarName(yeva, D);
    await store.addCalendarName(miraK, D);

    const card = await store.getStudentCard(taras);
    expect(titles(card)).toEqual([D, "taras afternoon", "Taras evening", "Taras morning"]);
    expect(card?.calendarNames[0]?.sharedWith).toEqual(["Mira K", "Yeva"]);
    expect((await store.getStudentCard(yeva))?.calendarNames[0]?.sharedWith).toEqual(["Mira K", "Taras"]);
    expect((await store.getTitleSets()).attached.get(titleKey(D))).toEqual([taras, miraK, yeva]);
    expect(await store.setArchived(taras, true)).toMatchObject({ detached: titles(card) });
  });
});
