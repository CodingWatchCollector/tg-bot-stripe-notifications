import type { PaymentReceived } from "../../src/domain/payment";
import { nameKey } from "../../src/domain/student";
import type { D1Fake } from "./d1";

export function addStudent(fake: D1Fake, name: string, opts: { emails?: string[]; archived?: boolean } = {}): number {
  const r = fake.raw.run(
    "INSERT INTO students(name, name_key, archived, created_at) VALUES (?1, ?2, ?3, '2026-10-01T00:00:00.000Z')",
    name,
    nameKey(name),
    opts.archived ? 1 : 0,
  );
  const id = Number(r.lastInsertRowid);
  for (const email of opts.emails ?? []) {
    fake.raw.run("INSERT INTO payer_emails(email, student_id) VALUES (?1, ?2)", email, id);
  }
  return id;
}

export function payment(over: Partial<PaymentReceived> = {}, session = "cs_1"): PaymentReceived {
  return {
    amountMinor: 16000,
    currency: "eur",
    customerName: "Anna K",
    customerEmail: "anna@example.com",
    paymentIntentId: "pi_123",
    paymentLinkId: null,
    livemode: true,
    source: {
      provider: "stripe",
      eventId: "evt_1",
      checkoutSessionId: session,
      clientReferenceId: null,
      metadata: {},
    },
    ...over,
  };
}
