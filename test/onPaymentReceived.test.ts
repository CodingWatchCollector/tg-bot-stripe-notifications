import { describe, expect, test, vi } from "vitest";
import { makeOnPaymentReceived } from "../src/app/onPaymentReceived";
import { expectedPayment } from "./fixtures";

const text =
  "Payment received: 45.00 EUR\nCustomer: Anna K <anna@example.com>\nhttps://dashboard.stripe.com/payments/pi_123";

describe("makeOnPaymentReceived", () => {
  test("sends the formatted message once", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await makeOnPaymentReceived({ notifier: { send } })(expectedPayment);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(text);
  });

  test("propagates a send failure unchanged", async () => {
    const failure = new Error("down");
    const send = vi.fn().mockRejectedValue(failure);
    await expect(makeOnPaymentReceived({ notifier: { send } })(expectedPayment)).rejects.toBe(failure);
  });
});
