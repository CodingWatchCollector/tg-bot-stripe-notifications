import { titleKey } from "../domain/calendar";
import type { PaymentReceived } from "../domain/payment";
import type { Product } from "../domain/products";
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
  lessons: number;
  productName: string | null;
  correction: number;
  studentBalance: number | null;
}

export type RecordedPayment = PaymentView & { unarchived: boolean };

export interface StudentSummary {
  id: number;
  name: string;
  balance: number;
}

export type AssignOutcome =
  | { kind: "assigned"; payment: PaymentView; email: "saved" | "none" | { ownedBy: Student }; unarchived: boolean }
  | { kind: "already_resolved"; payment: PaymentView }
  | { kind: "not_found" };

export type DismissOutcome =
  | { kind: "dismissed"; payment: PaymentView }
  | { kind: "already_resolved"; payment: PaymentView }
  | { kind: "not_found" };

export type AdjustPaymentOutcome = { kind: "adjusted"; payment: PaymentView } | { kind: "not_found" };

export type AdjustStudentOutcome =
  | { kind: "adjusted"; student: Student; before: number; after: number; unarchived: boolean }
  | { kind: "not_found" };

export interface CalendarNameView {
  title: string;
  titleKey: string;
  sharedWith: string[];
}

export interface StudentCard extends Student {
  balance: number;
  emails: string[];
  calendarNames: CalendarNameView[];
}

export type AddCalendarNameOutcome =
  | { kind: "added"; card: StudentCard; title: string; sharedWith: string[]; unignored: boolean }
  | { kind: "already_resolved"; card: StudentCard; title: string }
  | { kind: "archived"; card: StudentCard }
  | { kind: "not_found" };

export type RemoveCalendarNameOutcome =
  | { kind: "removed"; card: StudentCard; title: string }
  | { kind: "already_resolved"; card: StudentCard }
  | { kind: "not_found" };

export interface TitleSets {
  attached: Map<string, number[]>;
  ignored: Set<string>;
}

export type RenameOutcome =
  | { kind: "renamed"; card: StudentCard; previousName: string }
  | { kind: "name_taken"; existing: Student }
  | { kind: "not_found" };

export type ArchiveOutcome =
  | { kind: "updated"; card: StudentCard; detached: string[] }
  | { kind: "already_resolved"; card: StudentCard; detached: string[] }
  | { kind: "not_found" };

export type AddEmailOutcome =
  | { kind: "added"; card: StudentCard }
  | { kind: "already_resolved"; card: StudentCard }
  | { kind: "email_taken"; owner: Student }
  | { kind: "not_found" };

export type RemoveEmailOutcome =
  | { kind: "removed"; card: StudentCard }
  | { kind: "already_resolved"; card: StudentCard }
  | { kind: "not_found" };

export type UsernameOutcome = { kind: "updated"; card: StudentCard } | { kind: "not_found" };

export interface Store {
  findStudentByEmail(email: string): Promise<Student | null>;
  listActiveStudents(): Promise<Student[]>;
  findStudentByNameKey(key: string): Promise<Student | null>;
  renameStudent(studentId: number, name: string): Promise<RenameOutcome>;
  recordPayment(p: PaymentReceived, matched: Student | null, product?: Product | null): Promise<RecordedPayment>;
  markNotified(paymentId: number, messageId: number): Promise<void>;
  getPayment(id: number): Promise<PaymentView | null>;
  assignPayment(paymentId: number, studentId: number): Promise<AssignOutcome>;
  createStudentAndAssign(paymentId: number, name: string): Promise<AssignOutcome | { kind: "name_taken"; existing: Student }>;
  dismissPayment(paymentId: number): Promise<DismissOutcome>;
  adjustPayment(paymentId: number, delta: 1 | -1): Promise<AdjustPaymentOutcome>;
  adjustStudent(studentId: number, delta: number, reason: string): Promise<AdjustStudentOutcome>;
  listStudentBalances(archived?: boolean): Promise<StudentSummary[]>;
  getStudentCard(studentId: number): Promise<StudentCard | null>;
  setArchived(studentId: number, archived: boolean): Promise<ArchiveOutcome>;
  addEmail(studentId: number, email: string): Promise<AddEmailOutcome>;
  removeEmail(studentId: number, email: string): Promise<RemoveEmailOutcome>;
  setUsername(studentId: number, username: string | null): Promise<UsernameOutcome>;
  addCalendarName(studentId: number, title: string): Promise<AddCalendarNameOutcome>;
  removeCalendarName(studentId: number, titleKey: string): Promise<RemoveCalendarNameOutcome>;
  getTitleSets(): Promise<TitleSets>;
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
  lessons: r.lessons as number,
  productName: (r.product_name as string | null) ?? null,
  correction: r.correction as number,
  studentBalance: (r.student_balance as number | null) ?? null,
});

// `s` is a column expression, never input. v2.2 subtracts counted Lessons here and nowhere else.
const balanceSql = (s: string) =>
  `((SELECT COALESCE(SUM(c.lessons), 0) FROM payments c WHERE c.student_id = ${s} AND c.status = 'assigned')` +
  ` + (SELECT COALESCE(SUM(a.delta), 0) FROM adjustments a WHERE a.student_id = ${s}))`;

const PAYMENT_SELECT =
  `SELECT p.*, s.name AS student_name,
  (SELECT COALESCE(SUM(a.delta), 0) FROM adjustments a
     WHERE a.payment_id = p.id AND a.student_id = p.student_id) AS correction,
  CASE WHEN p.student_id IS NULL THEN NULL ELSE ${balanceSql("p.student_id")} END AS student_balance
FROM payments p LEFT JOIN students s ON s.id = p.student_id`;

const saveEmailSql = (studentIdSql: string): string => `INSERT INTO payer_emails(email, student_id)
  SELECT customer_email, student_id FROM payments
  WHERE id = ?1 AND status = 'assigned' AND student_id = ${studentIdSql} AND customer_email IS NOT NULL
  ON CONFLICT(email) DO NOTHING`;

const titleCollator = new Intl.Collator("en", { sensitivity: "base" });

export function calendarNameParts(input: string): { title: string; key: string } {
  const title = normalizeName(input.normalize("NFC"));
  const key = titleKey(title);
  if (key === "") throw new Error("calendar name is empty");
  return { title, key };
}

// Guards stay in the statement so v2.2d can batch it: an archived Student and an Ignored key both insert nothing.
export function attachTitleStatement(db: D1Database, studentId: number, title: string, createdAt: string): D1PreparedStatement {
  const { title: clean, key } = calendarNameParts(title);
  return db
    .prepare(
      "INSERT INTO calendar_names(title_key, student_id, title, created_at) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM students WHERE id = ?2 AND archived = 0) AND NOT EXISTS (SELECT 1 FROM ignored_titles WHERE title_key = ?1) ON CONFLICT(title_key, student_id) DO NOTHING RETURNING title_key",
    )
    .bind(key, studentId, clean, createdAt);
}

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

  async function cardById(id: number): Promise<StudentCard | null> {
    const r = await one(`SELECT s.*, ${balanceSql("s.id")} AS balance FROM students s WHERE s.id = ?1`, id);
    if (r === null) return null;
    const { results } = await db.prepare("SELECT email FROM payer_emails WHERE student_id = ?1 ORDER BY email").bind(id).all<Row>();
    const names = await db
      .prepare(
        `SELECT c.title_key, c.title, o.name AS other FROM calendar_names c
         LEFT JOIN calendar_names x ON x.title_key = c.title_key AND x.student_id <> c.student_id
         LEFT JOIN students o ON o.id = x.student_id AND o.archived = 0
         WHERE c.student_id = ?1`,
      )
      .bind(id)
      .all<Row>();
    const byKey = new Map<string, CalendarNameView>();
    for (const n of names.results) {
      const key = n.title_key as string;
      const view = byKey.get(key) ?? { title: n.title as string, titleKey: key, sharedWith: [] };
      if (n.other !== null) view.sharedWith.push(n.other as string);
      byKey.set(key, view);
    }
    const calendarNames = [...byKey.values()]
      .map((v) => ({ ...v, sharedWith: v.sharedWith.sort(titleCollator.compare) }))
      .sort((a, b) => titleCollator.compare(a.title, b.title) || (a.titleKey < b.titleKey ? -1 : a.titleKey > b.titleKey ? 1 : 0));
    return { ...toStudent(r), balance: r.balance as number, emails: results.map((e) => e.email as string), calendarNames };
  }

  async function committedCard(id: number): Promise<StudentCard> {
    const card = await cardById(id);
    if (card === null) throw new Error("student missing after write");
    return card;
  }

  const emailOutcome = (payment: PaymentView, owner: Student | null, studentId: number | null) => {
    if (payment.customerEmail === null) return "none" as const;
    if (owner === null) return "saved" as const;
    return owner.id === studentId ? ("none" as const) : { ownedBy: owner };
  };

  async function assignedOutcome(
    paymentId: number,
    owner: Student | null,
    studentId: number | null,
    unarchived: boolean,
  ): Promise<AssignOutcome> {
    const payment = await getPayment(paymentId);
    if (payment === null) return { kind: "not_found" };
    if (payment.status !== "assigned" || payment.studentId !== studentId) return { kind: "already_resolved", payment };
    return { kind: "assigned", payment, email: emailOutcome(payment, owner, studentId), unarchived };
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

    async renameStudent(studentId, name) {
      const clean = normalizeName(name);
      const key = nameKey(clean);
      const before = await studentById(studentId);
      if (before === null) return { kind: "not_found" };

      const [update] = await db.batch([
        db.prepare("UPDATE OR IGNORE students SET name = ?1, name_key = ?2 WHERE id = ?3 RETURNING id").bind(clean, key, studentId),
      ]);
      if (update?.results.length === 1) return { kind: "renamed", card: await committedCard(studentId), previousName: before.name };
      if ((await studentById(studentId)) === null) return { kind: "not_found" };
      const holder = await studentByKey(key);
      if (holder !== null && holder.id !== studentId) return { kind: "name_taken", existing: holder };
      throw new Error("rename ignored without a name holder");
    },

    async setArchived(studentId, archived) {
      const [update, detach] = await db.batch([
        db.prepare("UPDATE students SET archived = ?1 WHERE id = ?2 AND archived <> ?1 RETURNING id").bind(archived ? 1 : 0, studentId),
        ...(archived ? [db.prepare("DELETE FROM calendar_names WHERE student_id = ?1 RETURNING title").bind(studentId)] : []),
      ]);
      const card = await cardById(studentId);
      if (card === null) return { kind: "not_found" };
      const detached = (detach?.results ?? []).map((r) => (r as Row).title as string).sort(titleCollator.compare);
      return update?.results.length === 1 ? { kind: "updated", card, detached } : { kind: "already_resolved", card, detached };
    },

    async addEmail(studentId, email) {
      const [insert] = await db.batch([
        db
          .prepare(
            `INSERT INTO payer_emails(email, student_id)
             SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM students WHERE id = ?2)
             ON CONFLICT(email) DO NOTHING RETURNING student_id`,
          )
          .bind(email, studentId),
      ]);
      if (insert?.results.length === 1) return { kind: "added", card: await committedCard(studentId) };
      const card = await cardById(studentId);
      if (card === null) return { kind: "not_found" };
      const owner = await emailOwner(email);
      if (owner === null) throw new Error("email insert ignored without an owner");
      return owner.id === studentId ? { kind: "already_resolved", card } : { kind: "email_taken", owner };
    },

    async removeEmail(studentId, email) {
      const [del] = await db.batch([
        db.prepare("DELETE FROM payer_emails WHERE email = ?1 AND student_id = ?2 RETURNING email").bind(email, studentId),
      ]);
      const card = await cardById(studentId);
      if (card === null) return { kind: "not_found" };
      return del?.results.length === 1 ? { kind: "removed", card } : { kind: "already_resolved", card };
    },

    async setUsername(studentId, username) {
      const { results } = await db
        .prepare("UPDATE students SET telegram_username = ?1 WHERE id = ?2 RETURNING id")
        .bind(username, studentId)
        .all<Row>();
      if (results.length !== 1) return { kind: "not_found" };
      return { kind: "updated", card: await committedCard(studentId) };
    },

    async addCalendarName(studentId, input) {
      const { title, key } = calendarNameParts(input);
      const [unignore, insert] = await db.batch([
        db.prepare("DELETE FROM ignored_titles WHERE title_key = ?1 AND EXISTS (SELECT 1 FROM students WHERE id = ?2 AND archived = 0) RETURNING title_key").bind(key, studentId),
        attachTitleStatement(db, studentId, title, now()),
      ]);
      if (insert?.results.length === 1) {
        const card = await committedCard(studentId);
        const sharedWith = card.calendarNames.find((n) => n.titleKey === key)?.sharedWith ?? [];
        return { kind: "added", card, title, sharedWith, unignored: unignore?.results.length === 1 };
      }
      const card = await cardById(studentId);
      if (card === null) return { kind: "not_found" };
      if (card.archived) return { kind: "archived", card };
      const stored = card.calendarNames.find((n) => n.titleKey === key);
      if (stored === undefined) throw new Error("calendar name insert ignored without a reason");
      return { kind: "already_resolved", card, title: stored.title };
    },

    async removeCalendarName(studentId, key) {
      const [del] = await db.batch([
        db.prepare("DELETE FROM calendar_names WHERE title_key = ?1 AND student_id = ?2 RETURNING title").bind(key, studentId),
      ]);
      const card = await cardById(studentId);
      if (card === null) return { kind: "not_found" };
      const row = del?.results[0] as Row | undefined;
      return row === undefined ? { kind: "already_resolved", card } : { kind: "removed", card, title: row.title as string };
    },

    async getTitleSets() {
      const names = await db
        .prepare(
          `SELECT c.title_key, c.student_id FROM calendar_names c JOIN students s ON s.id = c.student_id
           WHERE s.archived = 0 ORDER BY c.title_key, c.student_id`,
        )
        .all<Row>();
      const ignored = await db.prepare("SELECT title_key FROM ignored_titles").all<Row>();
      const attached = new Map<string, number[]>();
      for (const r of names.results) {
        const key = r.title_key as string;
        attached.set(key, [...(attached.get(key) ?? []), r.student_id as number]);
      }
      return { attached, ignored: new Set(ignored.results.map((r) => r.title_key as string)) };
    },

    getStudentCard: cardById,

    async recordPayment(p, matched, product = null) {
      const [, unarchive] = await db.batch([
        db
          .prepare(
            `INSERT INTO payments(checkout_session_id, status, student_id, amount_minor, currency, customer_name,
               customer_email, payment_intent_id, payment_link_id, lessons, product_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
            product?.lessons ?? 0,
            product?.name ?? null,
            now(),
          ),
        db
          .prepare(
            `UPDATE students SET archived = 0
             WHERE archived = 1 AND id = (SELECT student_id FROM payments WHERE checkout_session_id = ?1 AND status = 'assigned' AND lessons > 0 AND notified_at IS NULL)
             RETURNING id`,
          )
          .bind(p.source.checkoutSessionId),
      ]);
      const r = await one(`${PAYMENT_SELECT} WHERE p.checkout_session_id = ?1`, p.source.checkoutSessionId);
      if (r === null) throw new Error("payment row missing after insert");
      return { ...toPayment(r), unarchived: unarchive?.results.length === 1 };
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

      const [update, , unarchive] = await db.batch([
        db
          .prepare("UPDATE payments SET status = 'assigned', student_id = ?1 WHERE id = ?2 AND status = 'unassigned'")
          .bind(studentId, paymentId),
        db.prepare(saveEmailSql("?2")).bind(paymentId, studentId),
        db
          .prepare(
            `UPDATE students SET archived = 0
             WHERE id = ?1 AND archived = 1 AND EXISTS (SELECT 1 FROM payments WHERE id = ?2 AND status = 'assigned' AND student_id = ?1 AND lessons > 0)
             RETURNING id`,
          )
          .bind(studentId, paymentId),
      ]);
      if (update?.meta.changes === 0) {
        const current = await getPayment(paymentId);
        return current === null ? { kind: "not_found" } : { kind: "already_resolved", payment: current };
      }
      return assignedOutcome(paymentId, owner, studentId, unarchive?.results.length === 1);
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
      return assignedOutcome(paymentId, owner, created?.id ?? null, false);
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

    async adjustPayment(paymentId, delta) {
      const { results } = await db
        .prepare(
          `INSERT INTO adjustments(student_id, delta, reason, payment_id, created_at)
           SELECT student_id, ?1, 'payment correction', id, ?2 FROM payments
           WHERE id = ?3 AND status = 'assigned' AND lessons > 0
           RETURNING id`,
        )
        .bind(delta, now(), paymentId)
        .all<Row>();
      if (results.length !== 1) return { kind: "not_found" };
      const payment = await getPayment(paymentId);
      return payment === null ? { kind: "not_found" } : { kind: "adjusted", payment };
    },

    async adjustStudent(studentId, delta, reason) {
      const [insert, unarchive] = await db.batch([
        db
          .prepare(
            `INSERT INTO adjustments(student_id, delta, reason, payment_id, created_at)
             SELECT ?1, ?2, ?3, NULL, ?4
             WHERE EXISTS (SELECT 1 FROM students WHERE id = ?1)
             RETURNING id`,
          )
          .bind(studentId, delta, reason, now()),
        db.prepare("UPDATE students SET archived = 0 WHERE id = ?1 AND archived = 1 RETURNING id").bind(studentId),
      ]);
      if (insert?.results.length !== 1) return { kind: "not_found" };
      const r = await one(`SELECT s.*, ${balanceSql("s.id")} AS balance FROM students s WHERE s.id = ?1`, studentId);
      if (r === null) return { kind: "not_found" };
      const after = r.balance as number;
      return { kind: "adjusted", student: toStudent(r), before: after - delta, after, unarchived: unarchive?.results.length === 1 };
    },

    async listStudentBalances(archived = false) {
      const { results } = await db
        .prepare(`SELECT s.id, s.name, ${balanceSql("s.id")} AS balance FROM students s WHERE s.archived = ?1`)
        .bind(archived ? 1 : 0)
        .all<Row>();
      return results.map((r) => ({ id: r.id as number, name: r.name as string, balance: r.balance as number }));
    },
  };
}
