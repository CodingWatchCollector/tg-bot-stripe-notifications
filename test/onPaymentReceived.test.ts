import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeOnPaymentReceived } from "../src/app/onPaymentReceived";
import { createStore } from "../src/db/store";
import { createD1Fake, type D1Fake } from "./support/d1";
import { PRODUCTS_FIXTURE, addStudent } from "./support/seed";
import { expectedPayment } from "./fixtures";

const LINK = "https://dashboard.stripe.com/payments/pi_123";
const payment = { ...expectedPayment, amountMinor: 16000 };

let fake: D1Fake;
beforeEach(() => {
  fake = createD1Fake();
});

const setup = (send = vi.fn().mockResolvedValue({ messageId: 9 })) => ({
  send,
  run: makeOnPaymentReceived({ notifier: { send }, store: createStore(fake.d1), products: PRODUCTS_FIXTURE }),
});
const payments = () => fake.raw.all("SELECT status, message_id, notified_at FROM payments");

describe("makeOnPaymentReceived", () => {
  test("known payer: one message without buttons, row assigned and notified", async () => {
    addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const { send, run } = setup();
    await run(payment);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(`💶 Olena paid 160,00\u00a0€\n${LINK}`);
    expect(payments()).toMatchObject([{ status: "assigned", message_id: 9 }]);
    expect(payments()[0]?.notified_at).not.toBeNull();
  });

  test("unknown payer: picker message and unassigned row", async () => {
    addStudent(fake, "Olena");
    const { send, run } = setup();
    await run(payment);
    expect(send).toHaveBeenCalledWith(
      `💶 Unknown payer paid 160,00\u00a0€\nAnna K <anna@example.com>\nWho is this?\n${LINK}`,
      { buttons: expect.any(Array) },
    );
    expect(payments()).toMatchObject([{ status: "unassigned", message_id: 9 }]);
  });

  test("missing email goes to the picker", async () => {
    const { send, run } = setup();
    await run({ ...payment, customerEmail: null });
    expect(send.mock.calls[0]?.[0]).toContain("Anna K <unknown>");
  });

  test("a notified payment is not announced again", async () => {
    const { send, run } = setup();
    await run(payment);
    await run({ ...payment, source: { ...payment.source, eventId: "evt_2" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(payments()).toHaveLength(1);
  });

  test("a Telegram failure keeps the row unnotified and propagates", async () => {
    const failure = new Error("down");
    const { run } = setup(vi.fn().mockRejectedValue(failure));
    await expect(run(payment)).rejects.toBe(failure);
    expect(payments()).toMatchObject([{ status: "unassigned", message_id: null, notified_at: null }]);
  });

  test("the resend renders the stored status", async () => {
    const failing = setup(vi.fn().mockRejectedValue(new Error("down")));
    await expect(failing.run(payment)).rejects.toThrow();
    addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const { send, run } = setup();
    await run(payment);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain("Unknown payer");
    expect(payments()).toHaveLength(1);
    expect(payments()[0]?.notified_at).not.toBeNull();
  });

  test("a D1 failure sends nothing", async () => {
    const { send, run } = setup();
    fake.failNext();
    await expect(run(payment)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("makeOnPaymentReceived with products", () => {
  const T4 = "Індивідуальний пакет 4";
  const pack = { ...payment, paymentLinkId: "plink_t4" };

  test("a Pack from a known payer is sent with the Balance and the -1 / +1 buttons", async () => {
    addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const { send, run } = setup();
    await run(pack);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(`💶 Olena paid for 4 lessons (${T4}, 160,00\u00a0€)\nBalance: 0 → 4\n${LINK}`, {
      buttons: [[{ text: "-1", data: "p:1:-1" }, { text: "+1", data: "p:1:+1" }]],
    });
  });

  test("a delivery of an announced session sends nothing and credits once", async () => {
    const olena = addStudent(fake, "Olena", { emails: ["anna@example.com"] });
    const { send, run } = setup();
    await run(pack);
    await run({ ...pack, source: { ...pack.source, eventId: "evt_2" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(fake.raw.all(`SELECT lessons FROM payments WHERE student_id = ${olena}`)).toEqual([{ lessons: 4 }]);
  });

  describe("races between the payer lookup and the record", () => {
    let oldOne: number;
    beforeEach(() => {
      oldOne = addStudent(fake, "Old One", { emails: ["anna@example.com"], archived: true });
    });

    test("a concurrent delivery already announced the session: nothing is sent", async () => {
      fake.beforeNextBatch(() => {
        fake.raw.run(
          "INSERT INTO payments(checkout_session_id, status, student_id, lessons, notified_at, created_at) VALUES ('cs_test_1', 'assigned', ?1, 4, 'n', 't')",
          oldOne,
        );
      });
      const { send, run } = setup();
      await run(pack);
      expect(send).not.toHaveBeenCalled();
      expect(fake.raw.all("SELECT archived FROM students")).toEqual([{ archived: 1 }]);
    });

    test("the Student became active meanwhile: the message has no unarchive line", async () => {
      fake.beforeNextBatch(() => {
        fake.raw.run("UPDATE students SET archived = 0 WHERE id = ?1", oldOne);
      });
      const { send, run } = setup();
      await run(pack);
      expect(send).toHaveBeenCalledTimes(1);
      expect(String(send.mock.calls[0]?.[0])).not.toContain("active again");
    });
  });
});
