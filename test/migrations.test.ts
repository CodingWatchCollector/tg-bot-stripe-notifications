import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vitest";
import first from "../migrations/0001_students_payments.sql?raw";
import second from "../migrations/0002_drop_payments_livemode.sql?raw";
import third from "../migrations/0003_balances.sql?raw";
import fourth from "../migrations/0004_calendar_names.sql?raw";

let db: DatabaseSync;
const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
const rejects = (sql: string) => expect(() => db.exec(sql)).toThrow();

const FULL_ROW = `INSERT INTO payments(id, checkout_session_id, status, student_id, amount_minor, currency, customer_name,
  customer_email, payment_intent_id, payment_link_id, livemode, message_id, notified_at, created_at)
  VALUES (7, 'cs_1', 'assigned', 1, 16000, 'eur', 'Anna K', 'a@x.com', 'pi_1', 'plink_1', 1, 55, 'n', 't')`;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(first);
  db.exec("INSERT INTO students(id, name, name_key, created_at) VALUES (1, 'Ira', 'ira', 't')");
  db.exec(FULL_ROW);
  db.exec(second);
});

describe("0002 drop payments livemode", () => {
  test("is one statement", () => {
    expect(second.split(";").filter((p) => p.trim() !== "")).toHaveLength(1);
  });

  test("removes only the livemode column", () => {
    expect(all("PRAGMA table_info(payments)").map((c) => c.name)).toEqual([
      "id", "checkout_session_id", "status", "student_id", "amount_minor", "currency", "customer_name",
      "customer_email", "payment_intent_id", "payment_link_id", "message_id", "notified_at", "created_at",
    ]);
  });

  test("keeps the row values", () => {
    expect(all("SELECT * FROM payments")).toEqual([
      {
        id: 7, checkout_session_id: "cs_1", status: "assigned", student_id: 1, amount_minor: 16000, currency: "eur",
        customer_name: "Anna K", customer_email: "a@x.com", payment_intent_id: "pi_1", payment_link_id: "plink_1",
        message_id: 55, notified_at: "n", created_at: "t",
      },
    ]);
  });

  test("keeps the table checks", () => {
    rejects("INSERT INTO payments(checkout_session_id, status, created_at) VALUES ('c','assigned','t')");
    rejects("INSERT INTO payments(checkout_session_id, status, student_id, created_at) VALUES ('c','unassigned',1,'t')");
    rejects("INSERT INTO payments(checkout_session_id, status, created_at) VALUES ('c','paid','t')");
  });

  test("keeps the unique session id", () => {
    rejects("INSERT INTO payments(checkout_session_id, status, created_at) VALUES ('cs_1','unassigned','t')");
  });

  test("keeps the student foreign key", () => {
    expect(all("PRAGMA foreign_key_list(payments)")).toMatchObject([{ from: "student_id", table: "students", to: "id" }]);
  });

  test("keeps NOT NULL on session id and created_at", () => {
    rejects("INSERT INTO payments(status, created_at) VALUES ('unassigned','t')");
    rejects("INSERT INTO payments(checkout_session_id, status) VALUES ('c','unassigned')");
  });
});

describe("0003 balances", () => {
  beforeEach(() => {
    db.exec(third);
  });

  const insertAdjustment = (cols: string, ...values: string[]) =>
    `INSERT INTO adjustments(${cols}, created_at) VALUES (${values.join(", ")}, 't')`;

  test("existing rows get lessons 0 and no product name and keep their values", () => {
    expect(all("SELECT * FROM payments")).toEqual([
      {
        id: 7, checkout_session_id: "cs_1", status: "assigned", student_id: 1, amount_minor: 16000, currency: "eur",
        customer_name: "Anna K", customer_email: "a@x.com", payment_intent_id: "pi_1", payment_link_id: "plink_1",
        message_id: 55, notified_at: "n", created_at: "t", lessons: 0, product_name: null,
      },
    ]);
  });

  test("payments gains exactly lessons and product_name", () => {
    expect(all("PRAGMA table_info(payments)").map((c) => c.name)).toEqual([
      "id", "checkout_session_id", "status", "student_id", "amount_minor", "currency", "customer_name",
      "customer_email", "payment_intent_id", "payment_link_id", "message_id", "notified_at", "created_at",
      "lessons", "product_name",
    ]);
  });

  test("lessons must be a non-negative integer", () => {
    const withLessons = (v: string) => `INSERT INTO payments(checkout_session_id, status, lessons, created_at) VALUES ('c', 'unassigned', ${v}, 't')`;
    rejects(withLessons("-1"));
    rejects(withLessons("NULL"));
    rejects(withLessons("4.5"));
    db.prepare(`INSERT INTO payments(checkout_session_id, status, lessons, created_at) VALUES ('c', 'unassigned', ?1, 't')`).run(4);
    expect(all("SELECT lessons FROM payments WHERE checkout_session_id = 'c'")).toEqual([{ lessons: 4 }]);
  });

  test("v2.1a inserts without the new columns still work", () => {
    db.exec("INSERT INTO payments(checkout_session_id, status, created_at) VALUES ('old', 'unassigned', 't')");
    expect(all("SELECT lessons, product_name FROM payments WHERE checkout_session_id = 'old'")).toEqual([{ lessons: 0, product_name: null }]);
  });

  test("an adjustment needs a non-zero integer delta and a non-blank reason", () => {
    db.exec(insertAdjustment("student_id, delta, reason", "1", "2", "'ok'"));
    rejects(insertAdjustment("student_id, delta, reason", "1", "0", "'ok'"));
    rejects(insertAdjustment("student_id, delta, reason", "1", "1.5", "'ok'"));
    rejects(insertAdjustment("student_id, delta, reason", "1", "1", "'   '"));
    rejects(insertAdjustment("student_id, delta, reason", "1", "1", "''"));
  });

  test("an adjustment needs student, reason and created_at", () => {
    rejects("INSERT INTO adjustments(delta, reason, created_at) VALUES (1, 'r', 't')");
    rejects("INSERT INTO adjustments(student_id, delta, created_at) VALUES (1, 1, 't')");
    rejects("INSERT INTO adjustments(student_id, delta, reason) VALUES (1, 1, 'r')");
  });

  test("an adjustment references an existing student and payment", () => {
    rejects(insertAdjustment("student_id, delta, reason", "99", "1", "'r'"));
    rejects(insertAdjustment("student_id, delta, reason, payment_id", "1", "1", "'r'", "99"));
    db.exec(insertAdjustment("student_id, delta, reason, payment_id", "1", "1", "'r'", "7"));
  });

  test("both indexes exist", () => {
    expect(all("PRAGMA index_list(adjustments)").map((i) => i.name).sort()).toEqual(["adjustments_payment_id", "adjustments_student_id"]);
  });
});

describe("0004 calendar names", () => {
  const OLD_TABLES = ["students", "payer_emails", "payments", "adjustments"];
  const snapshot = () => ({
    rows: OLD_TABLES.map((t) => all(`SELECT * FROM ${t}`)),
    master: all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"),
  });

  beforeEach(() => {
    db.exec(third);
  });

  test("leaves every 0001-0003 row and object untouched", () => {
    db.exec("INSERT INTO payer_emails(email, student_id) VALUES ('a@x.com', 1)");
    db.exec("INSERT INTO adjustments(student_id, delta, reason, created_at) VALUES (1, 2, 'r', 't')");
    const before = snapshot();
    db.exec(fourth);
    const after = snapshot();
    expect(after.rows).toEqual(before.rows);
    expect(after.master.filter((o) => before.master.some((b) => b.name === o.name))).toEqual(before.master);
  });

  describe("after applying", () => {
    beforeEach(() => {
      db.exec(fourth);
    });

    const insertName = (cols: string, ...values: string[]) => `INSERT INTO calendar_names(${cols}) VALUES (${values.join(", ")})`;
    const insertIgnored = (cols: string, ...values: string[]) => `INSERT INTO ignored_titles(${cols}) VALUES (${values.join(", ")})`;

    test("calendar_names columns, primary key, foreign key and index", () => {
      const cols = all("PRAGMA table_info(calendar_names)");
      expect(cols.map((c) => c.name)).toEqual(["title_key", "student_id", "title", "created_at"]);
      expect(cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name)).toEqual(["title_key", "student_id"]);
      expect(all("PRAGMA foreign_key_list(calendar_names)")).toMatchObject([
        { from: "student_id", table: "students", to: "id", on_update: "NO ACTION", on_delete: "NO ACTION" },
      ]);
      expect(all("PRAGMA index_info(calendar_names_student_id)").map((c) => c.name)).toEqual(["student_id"]);
    });

    test("ignored_titles columns and primary key", () => {
      const cols = all("PRAGMA table_info(ignored_titles)");
      expect(cols.map((c) => c.name)).toEqual(["title_key", "title", "created_at"]);
      expect(cols.filter((c) => Number(c.pk) > 0).map((c) => c.name)).toEqual(["title_key"]);
    });

    test("calendar_names accepts a full row and the same key for two Students", () => {
      db.exec("INSERT INTO students(id, name, name_key, created_at) VALUES (2, 'Yeva', 'yeva', 't')");
      db.exec(insertName("title_key, student_id, title, created_at", "'duo'", "1", "'Duo'", "'t'"));
      db.exec(insertName("title_key, student_id, title, created_at", "'duo'", "2", "'duo'", "'t'"));
      expect(all("SELECT student_id FROM calendar_names ORDER BY student_id")).toEqual([{ student_id: 1 }, { student_id: 2 }]);
    });

    test.each([
      ["duplicate key and student", insertName("title_key, student_id, title, created_at", "'k'", "1", "'K'", "'t'")],
      ["unknown student", insertName("title_key, student_id, title, created_at", "'z'", "99", "'Z'", "'t'")],
      ["NULL student", insertName("title_key, title, created_at", "'z'", "'Z'", "'t'")],
      ["NULL key", insertName("student_id, title, created_at", "1", "'Z'", "'t'")],
      ["empty key", insertName("title_key, student_id, title, created_at", "''", "1", "'Z'", "'t'")],
      ["NULL title", insertName("title_key, student_id, created_at", "'z'", "1", "'t'")],
      ["blank title", insertName("title_key, student_id, title, created_at", "'z'", "1", "'   '", "'t'")],
      ["missing created_at", insertName("title_key, student_id, title", "'z'", "1", "'Z'")],
    ])("calendar_names rejects %s", (_name, sql) => {
      db.exec(insertName("title_key, student_id, title, created_at", "'k'", "1", "'K'", "'t'"));
      rejects(sql);
    });

    test.each([
      ["duplicate key", insertIgnored("title_key, title, created_at", "'k'", "'K'", "'t'")],
      ["NULL key", insertIgnored("title, created_at", "'Z'", "'t'")],
      ["empty key", insertIgnored("title_key, title, created_at", "''", "'Z'", "'t'")],
      ["NULL title", insertIgnored("title_key, created_at", "'z'", "'t'")],
      ["blank title", insertIgnored("title_key, title, created_at", "'z'", "'  '", "'t'")],
      ["missing created_at", insertIgnored("title_key, title", "'z'", "'Z'")],
    ])("ignored_titles rejects %s", (_name, sql) => {
      db.exec(insertIgnored("title_key, title, created_at", "'k'", "'K'", "'t'"));
      rejects(sql);
    });
  });
});
