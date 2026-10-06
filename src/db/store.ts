import type { PaymentReceived } from "../domain/payment";
import { nameKey, normalizeName, type Student } from "../domain/student";

export type PaymentStatus = "unassigned" | "assigned" | "dismissed";

export interface PaymentView {
  id: number;
  checkoutSessionId: string;
  status: PaymentStatus;
  studentId: number | null;
  studentName: string | null;
  amountMinor: number | null;
  currency: string | null;
  customerName: string | null;
  customerEmail: string | null;
  paymentIntentId: string | null;
  paymentLinkId: string | null;
  messageId: number | null;
  notifiedAt: string | null;
  createdAt: string;
}

export type AssignOutcome =
  | { kind: "assigned"; payment: PaymentView; email: "saved" | "none" | { ownedBy: Student } }
  | { kind: "already_resolved"; payment: PaymentView }
  | { kind: "not_found" };

export type DismissOutcome =
  | { kind: "dismissed"; payment: PaymentView }
  | { kind: "already_resolved"; payment: PaymentView }
  | { kind: "not_found" };

export interface Store {
  findStudentByEmail(email: string): Promise<Student | null>;
  listActiveStudents(): Promise<Student[]>;
  findStudentByNameKey(key: string): Promise<Student | null>;
  renameStudent(id: number, name: string): Promise<"ok" | "name_taken" | "not_found">;
  recordPayment(p: PaymentReceived, matched: Student | null): Promise<PaymentView>;
  markNotified(paymentId: number, messageId: number): Promise<void>;
  getPayment(id: number): Promise<PaymentView | null>;
  assignPayment(paymentId: number, studentId: number): Promise<AssignOutcome>;
  createStudentAndAssign(paymentId: number, name: string): Promise<AssignOutcome | { kind: "name_taken"; existing: Student }>;
  dismissPayment(paymentId: number): Promise<DismissOutcome>;
}

type Row = Record<string, unknown>;

const toStudent = (r: Row): Student => ({
  id: r.id as number,
  name: r.name as string,
  nameKey: r.name_key as string,
  telegramUsername: (r.telegram_username as string | null) ?? null,
  archived: r.archived === 1,
  createdAt: r.created_at as string,
});

const toPayment = (r: Row): PaymentView => ({
  id: r.id as number,
  checkoutSessionId: r.checkout_session_id as string,
  status: r.status as PaymentStatus,
  studentId: (r.student_id as number | null) ?? null,
  studentName: (r.student_name as string | null) ?? null,
  amountMinor: (r.amount_minor as number | null) ?? null,
  currency: (r.currency as string | null) ?? null,
  customerName: (r.customer_name as string | null) ?? null,
  customerEmail: (r.customer_email as string | null) ?? null,
  paymentIntentId: (r.payment_intent_id as string | null) ?? null,
  paymentLinkId: (r.payment_link_id as string | null) ?? null,
  messageId: (r.message_id as number | null) ?? null,
  notifiedAt: (r.notified_at as string | null) ?? null,
  createdAt: r.created_at as string,
});

const PAYMENT_SELECT =
  "SELECT p.*, s.name AS student_name FROM payments p LEFT JOIN students s ON s.id = p.student_id";

const saveEmailSql = (studentIdSql: string): string => `INSERT INTO payer_emails(email, student_id)
  SELECT customer_email, student_id FROM payments
  WHERE id = ?1 AND status = 'assigned' AND student_id = ${studentIdSql} AND customer_email IS NOT NULL
  ON CONFLICT(email) DO NOTHING`;

export function createStore(db: D1Database): Store {
  const now = () => new Date().toISOString();

  async function one(sql: string, ...params: unknown[]): Promise<Row | null> {
    return (await db.prepare(sql).bind(...params).first<Row>()) ?? null;
  }

  const getPayment = async (id: number): Promise<PaymentView | null> => {
    const r = await one(`${PAYMENT_SELECT} WHERE p.id = ?1`, id);
    return r === null ? null : toPayment(r);
  };

  async function studentById(id: number): Promise<Student | null> {
    const r = await one("SELECT * FROM students WHERE id = ?1", id);
    return r === null ? null : toStudent(r);
  }

  async function studentByKey(key: string): Promise<Student | null> {
    const r = await one("SELECT * FROM students WHERE name_key = ?1", key);
    return r === null ? null : toStudent(r);
  }

  async function emailOwner(email: string | null): Promise<Student | null> {
    if (email === null) return null;
    const r = await one(
      "SELECT s.* FROM payer_emails e JOIN students s ON s.id = e.student_id WHERE e.email = ?1",
      email,
    );
    return r === null ? null : toStudent(r);
  }

  const emailOutcome = (payment: PaymentView, owner: Student | null, studentId: number | null) => {
    if (payment.customerEmail === null) return "none" as const;
    if (owner === null) return "saved" as const;
    return owner.id === studentId ? ("none" as const) : { ownedBy: owner };
  };

  async function assignedOutcome(paymentId: number, owner: Student | null, studentId: number | null): Promise<AssignOutcome> {
    const payment = await getPayment(paymentId);
    if (payment === null) return { kind: "not_found" };
    if (payment.status !== "assigned" || payment.studentId !== studentId) return { kind: "already_resolved", payment };
    return { kind: "assigned", payment, email: emailOutcome(payment, owner, studentId) };
  }

  return {
    async findStudentByEmail(email) {
      return emailOwner(email);
    },

    async listActiveStudents() {
      const { results } = await db.prepare("SELECT * FROM students WHERE archived = 0").all<Row>();
      return results.map(toStudent);
    },

    findStudentByNameKey: studentByKey,

    async renameStudent(id, name) {
      const clean = normalizeName(name);
      const key = nameKey(clean);
      await db.prepare("UPDATE OR IGNORE students SET name = ?1, name_key = ?2 WHERE id = ?3").bind(clean, key, id).run();
      const student = await studentById(id);
      if (student === null) return "not_found";
      return student.nameKey === key ? "ok" : "name_taken";
    },

    async recordPayment(p, matched) {
      await db
        .prepare(
          `INSERT INTO payments(checkout_session_id, status, student_id, amount_minor, currency, customer_name,
             customer_email, payment_intent_id, payment_link_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(checkout_session_id) DO NOTHING`,
        )
        .bind(
          p.source.checkoutSessionId,
          matched === null ? "unassigned" : "assigned",
          matched?.id ?? null,
          p.amountMinor,
          p.currency,
          p.customerName,
          p.customerEmail,
          p.paymentIntentId,
          p.paymentLinkId,
          now(),
        )
        .run();
      const r = await one(`${PAYMENT_SELECT} WHERE p.checkout_session_id = ?1`, p.source.checkoutSessionId);
      if (r === null) throw new Error("payment row missing after insert");
      return toPayment(r);
    },

    async markNotified(paymentId, messageId) {
      await db
        .prepare("UPDATE payments SET message_id = ?1, notified_at = ?2 WHERE id = ?3")
        .bind(messageId, now(), paymentId)
        .run();
    },

    getPayment,

    async assignPayment(paymentId, studentId) {
      const payment = await getPayment(paymentId);
      if (payment === null) return { kind: "not_found" };
      const student = await studentById(studentId);
      if (student === null) return { kind: "not_found" };
      if (payment.status !== "unassigned") return { kind: "already_resolved", payment };
      const owner = await emailOwner(payment.customerEmail);

      const [update] = await db.batch([
        db
          .prepare("UPDATE payments SET status = 'assigned', student_id = ?1 WHERE id = ?2 AND status = 'unassigned'")
          .bind(studentId, paymentId),
        db.prepare(saveEmailSql("?2")).bind(paymentId, studentId),
      ]);
      if (update?.meta.changes === 0) {
        const current = await getPayment(paymentId);
        return current === null ? { kind: "not_found" } : { kind: "already_resolved", payment: current };
      }
      return assignedOutcome(paymentId, owner, studentId);
    },

    async createStudentAndAssign(paymentId, name) {
      const clean = normalizeName(name);
      const key = nameKey(clean);

      const read = async (): Promise<{ payment: PaymentView } | AssignOutcome | { kind: "name_taken"; existing: Student }> => {
        const payment = await getPayment(paymentId);
        if (payment === null) return { kind: "not_found" };
        if (payment.status !== "unassigned") return { kind: "already_resolved", payment };
        const existing = await studentByKey(key);
        return existing === null ? { payment } : { kind: "name_taken", existing };
      };

      const pre = await read();
      if ("kind" in pre) return pre;
      const owner = await emailOwner(pre.payment.customerEmail);

      try {
        const [insert] = await db.batch([
          db
            .prepare(
              `INSERT INTO students(name, name_key, created_at)
               SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM payments WHERE id = ?4 AND status = 'unassigned')`,
            )
            .bind(clean, key, now(), paymentId),
          db
            .prepare(
              `UPDATE payments SET status = 'assigned', student_id = (SELECT id FROM students WHERE name_key = ?1)
               WHERE id = ?2 AND status = 'unassigned'`,
            )
            .bind(key, paymentId),
          db.prepare(saveEmailSql("(SELECT id FROM students WHERE name_key = ?2)")).bind(paymentId, key),
        ]);
        if (insert?.meta.changes === 0) {
          const lost = await read();
          if ("kind" in lost) return lost;
          throw new Error("student insert changed nothing");
        }
      } catch (err) {
        const lost = await read();
        if ("kind" in lost) return lost;
        throw err;
      }
      const created = await studentByKey(key);
      return assignedOutcome(paymentId, owner, created?.id ?? null);
    },

    async dismissPayment(paymentId) {
      const payment = await getPayment(paymentId);
      if (payment === null) return { kind: "not_found" };
      if (payment.status !== "unassigned") return { kind: "already_resolved", payment };
      const [update] = await db.batch([
        db.prepare("UPDATE payments SET status = 'dismissed' WHERE id = ?1 AND status = 'unassigned'").bind(paymentId),
      ]);
      const current = await getPayment(paymentId);
      if (current === null) return { kind: "not_found" };
      return update?.meta.changes === 0 ? { kind: "already_resolved", payment: current } : { kind: "dismissed", payment: current };
    },
  };
}
