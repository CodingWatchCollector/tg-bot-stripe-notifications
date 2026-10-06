import { beforeEach, describe, expect, test, vi } from "vitest";
import { createStore, type Store } from "../src/db/store";
import { createD1Fake, type D1Fake } from "./support/d1";
import { addStudent, payment } from "./support/seed";

let fake: D1Fake;
let store: Store;
beforeEach(() => {
  fake = createD1Fake();
  store = createStore(fake.d1);
});

const rows = (sql: string) => fake.raw.all(sql);
const count = (table: string) => rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n;
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
