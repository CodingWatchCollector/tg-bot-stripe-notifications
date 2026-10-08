import { beforeEach, describe, expect, test, vi } from "vitest";
import { createStore, type Store } from "../src/db/store";
import { createD1Fake, type D1Fake } from "./support/d1";
import { PRODUCTS_FIXTURE, addAdjustment, addStudent, payment } from "./support/seed";

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
    expect(await store.renameStudent(id, "Olena K")).toBe("ok");
    expect(rows("SELECT name, name_key FROM students")).toEqual([{ name: "Olena K", name_key: "olena k" }]);
  });

  test("changing only the case succeeds", async () => {
    const id = addStudent(fake, "Olena");
    expect(await store.renameStudent(id, "OLENA")).toBe("ok");
    expect(rows("SELECT name FROM students")).toEqual([{ name: "OLENA" }]);
  });

  test("a name used by another student is refused", async () => {
    const id = addStudent(fake, "Olena");
    addStudent(fake, "Ira");
    expect(await store.renameStudent(id, "ira")).toBe("name_taken");
    expect(rows("SELECT name FROM students ORDER BY id")).toEqual([{ name: "Olena" }, { name: "Ira" }]);
  });

  test("unknown id", async () => {
    expect(await store.renameStudent(99, "X")).toBe("not_found");
    expect(count("students")).toBe(0);
  });
});
