export type StudentAction = "open" | "card" | "+1" | "-1" | "name" | "user" | "email+" | "email-" | "archive" | "unarchive";

export type Callback =
  | { kind: "assign"; paymentId: number; studentId: number }
  | { kind: "new_student"; paymentId: number }
  | { kind: "dismiss"; paymentId: number }
  | { kind: "adjust_payment"; paymentId: number; delta: 1 | -1 }
  | { kind: "student"; studentId: number; action: StudentAction }
  | { kind: "remove_email"; studentId: number; tag: string };

// Telegram caps callback data at 64 bytes; 16-digit ids keep the longest form at 37.
const PAYMENT = /^p:(\d{1,16}):(?:s:(\d{1,16})|(new)|(x)|([+-]1))$/;
const STUDENT = /^s:(\d{1,16}):(?:(open|card|\+1|-1|name|user|email\+|email-|archive|unarchive)|rm:([0-9a-f]{8}))$/;

export function callbackData(cb: Callback): string {
  switch (cb.kind) {
    case "assign":
      return `p:${cb.paymentId}:s:${cb.studentId}`;
    case "new_student":
      return `p:${cb.paymentId}:new`;
    case "dismiss":
      return `p:${cb.paymentId}:x`;
    case "adjust_payment":
      return `p:${cb.paymentId}:${cb.delta === 1 ? "+1" : "-1"}`;
    case "student":
      return `s:${cb.studentId}:${cb.action}`;
    case "remove_email":
      return `s:${cb.studentId}:rm:${cb.tag}`;
    default: {
      const unreachable: never = cb;
      return unreachable;
    }
  }
}

export const safeId = (digits: string | undefined): number | null => {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
};

export function parseCallback(data: string): Callback | null {
  const p = PAYMENT.exec(data);
  if (p !== null) {
    const paymentId = safeId(p[1]);
    if (paymentId === null) return null;
    if (p[2] !== undefined) {
      const studentId = safeId(p[2]);
      return studentId === null ? null : { kind: "assign", paymentId, studentId };
    }
    if (p[3] !== undefined) return { kind: "new_student", paymentId };
    if (p[4] !== undefined) return { kind: "dismiss", paymentId };
    return { kind: "adjust_payment", paymentId, delta: p[5] === "+1" ? 1 : -1 };
  }
  const s = STUDENT.exec(data);
  if (s === null) return null;
  const studentId = safeId(s[1]);
  if (studentId === null) return null;
  if (s[3] !== undefined) return { kind: "remove_email", studentId, tag: s[3] };
  return { kind: "student", studentId, action: s[2] as StudentAction };
}

// FNV-1a 32-bit over UTF-8 bytes. A tag is a short, stable button label resolved against current emails at tap time.
export function emailTag(email: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(email)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}
