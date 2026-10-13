import { safeId } from "./callbacks";

export type Prompt =
  | { kind: "new_student"; paymentId: number }
  | { kind: "rename"; studentId: number }
  | { kind: "add_email"; studentId: number }
  | { kind: "username"; studentId: number }
  | { kind: "add_title"; studentId: number };

const NEW_STUDENT = /^Name for the new student \(payment #(\d{1,16})\):$/;
const RENAME = /^New name for student #(\d{1,16}) \(.*\):$/;
const ADD_EMAIL = /^Email to add for student #(\d{1,16}) \(.*\):$/;
const ADD_TITLE = /^Calendar name to add for student #(\d{1,16}) \(.*\):$/;
const USERNAME = /^Telegram username for student #(\d{1,16}) \(.*\), or - to clear:$/;

export const newStudentPrompt = (paymentId: number): string => `Name for the new student (payment #${paymentId}):`;

export function promptText(p: Exclude<Prompt, { kind: "new_student" }>, name: string): string {
  switch (p.kind) {
    case "rename":
      return `New name for student #${p.studentId} (${name}):`;
    case "add_email":
      return `Email to add for student #${p.studentId} (${name}):`;
    case "username":
      return `Telegram username for student #${p.studentId} (${name}), or - to clear:`;
    case "add_title":
      return `Calendar name to add for student #${p.studentId} (${name}):`;
    default: {
      const unreachable: never = p;
      return unreachable;
    }
  }
}

// The id is authoritative; the name in the text is decoration. Anything after the first line is ignored, so a hint line can be added later without breaking old prompts.
export function parsePrompt(text: string): Prompt | null {
  const line = text.split("\n")[0] ?? "";
  const pairs = [
    [NEW_STUDENT, "new_student"],
    [RENAME, "rename"],
    [ADD_EMAIL, "add_email"],
    [USERNAME, "username"],
    [ADD_TITLE, "add_title"],
  ] as const;
  for (const [regex, kind] of pairs) {
    const id = safeId(regex.exec(line)?.[1]);
    if (id === null) continue;
    return kind === "new_student" ? { kind, paymentId: id } : { kind, studentId: id };
  }
  return null;
}
