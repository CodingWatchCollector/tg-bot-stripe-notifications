import { describe, expect, test } from "vitest";
import { callbackData, emailTag, parseCallback, type Callback, type StudentAction } from "../src/app/callbacks";

const MAX = 9007199254740991;
const ACTIONS: StudentAction[] = ["open", "card", "+1", "-1", "name", "user", "email+", "email-", "title+", "title-", "archive", "archive!", "unarchive"];

const everyKind = (id: number, pid: number): Callback[] => [
  { kind: "assign", paymentId: pid, studentId: id },
  { kind: "new_student", paymentId: pid },
  { kind: "dismiss", paymentId: pid },
  { kind: "adjust_payment", paymentId: pid, delta: 1 },
  { kind: "adjust_payment", paymentId: pid, delta: -1 },
  ...ACTIONS.map((action): Callback => ({ kind: "student", studentId: id, action })),
  { kind: "remove_email", studentId: id, tag: "7007e771" },
  { kind: "remove_title", studentId: id, tag: "0a1b2c3d" },
];

describe("callbackData", () => {
  test.each([
    [{ kind: "assign", paymentId: 12, studentId: 3 }, "p:12:s:3"],
    [{ kind: "new_student", paymentId: 12 }, "p:12:new"],
    [{ kind: "dismiss", paymentId: 12 }, "p:12:x"],
    [{ kind: "adjust_payment", paymentId: 12, delta: 1 }, "p:12:+1"],
    [{ kind: "adjust_payment", paymentId: 12, delta: -1 }, "p:12:-1"],
    [{ kind: "student", studentId: 3, action: "email+" }, "s:3:email+"],
    [{ kind: "remove_email", studentId: 3, tag: "7007e771" }, "s:3:rm:7007e771"],
    [{ kind: "student", studentId: 3, action: "title+" }, "s:3:title+"],
    [{ kind: "student", studentId: 3, action: "title-" }, "s:3:title-"],
    [{ kind: "student", studentId: 3, action: "archive!" }, "s:3:archive!"],
    [{ kind: "remove_title", studentId: 3, tag: "0a1b2c3d" }, "s:3:rt:0a1b2c3d"],
  ] as [Callback, string][])("%j -> %s", (cb, data) => {
    expect(callbackData(cb)).toBe(data);
  });
});

describe("parseCallback", () => {
  test.each([1, MAX])("round trips every kind and action with id %d", (id) => {
    const longest = Math.max(...everyKind(id, id).map((cb) => Buffer.byteLength(callbackData(cb))));
    expect(longest).toBe(id === MAX ? 37 : 15);
    for (const cb of everyKind(id, id)) {
      const data = callbackData(cb);
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toEqual(cb);
    }
  });

  test.each([
    "",
    "garbage",
    "s:1:bogus",
    "s:x:open",
    "p:1:+2",
    "p:1:s:",
    "s:1:rm:XYZ12345",
    "s:1:rm:abc",
    "s:1:rt:XYZ",
    "s:1:rt:1234567",
    "s:12345678901234567:rt:0a1b2c3d",
    "s:1:title",
    "s:1:archive!!",
    "s:1:open ",
    "q:1",
    "p:12345678901234567:x",
    "s:9007199254740992:open",
  ])("%j -> null", (data) => {
    expect(parseCallback(data)).toBeNull();
  });
});

describe("emailTag", () => {
  test.each([
    ["", "811c9dc5"],
    ["a", "e40c292c"],
    ["olena@example.com", "7007e771"],
    ["o2@example.com", "e5bb3129"],
    ["ira@example.com", "7fc48b74"],
    ["u31992@example.com", "120680e9"],
    ["u605430@example.com", "120680e9"],
  ])("%j -> %s", (email, tag) => {
    expect(emailTag(email)).toBe(tag);
  });
});
