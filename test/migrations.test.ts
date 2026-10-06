import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vitest";
import first from "../migrations/0001_students_payments.sql?raw";
import second from "../migrations/0002_drop_payments_livemode.sql?raw";

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
