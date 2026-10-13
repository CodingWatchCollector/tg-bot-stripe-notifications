import { describe, expect, test } from "vitest";
import { newStudentPrompt, parsePrompt, promptText } from "../src/app/prompts";

describe("promptText / parsePrompt", () => {
  test.each(["Olena", "Ira (Pasha) #2: x", "Анна 🎉"])("every card prompt for %j parses back", (name) => {
    for (const kind of ["rename", "add_email", "username", "add_title"] as const) {
      expect(parsePrompt(promptText({ kind, studentId: 7 }, name))).toEqual({ kind, studentId: 7 });
    }
  });

  test("texts", () => {
    expect(promptText({ kind: "rename", studentId: 3 }, "Olena")).toBe("New name for student #3 (Olena):");
    expect(promptText({ kind: "add_email", studentId: 3 }, "Olena")).toBe("Email to add for student #3 (Olena):");
    expect(promptText({ kind: "username", studentId: 3 }, "Olena")).toBe("Telegram username for student #3 (Olena), or - to clear:");
    expect(promptText({ kind: "add_title", studentId: 7 }, "Marko")).toBe("Calendar name to add for student #7 (Marko):");
  });

  test("the add_title prompt parses with or without a hint line", () => {
    const text = promptText({ kind: "add_title", studentId: 7 }, "Marko");
    expect(parsePrompt(text)).toEqual({ kind: "add_title", studentId: 7 });
    expect(parsePrompt(`${text}\nhint`)).toEqual({ kind: "add_title", studentId: 7 });
  });

  test("the new-student prompt text is unchanged and parses", () => {
    expect(newStudentPrompt(12)).toBe("Name for the new student (payment #12):");
    expect(parsePrompt(newStudentPrompt(12))).toEqual({ kind: "new_student", paymentId: 12 });
  });

  test("the first line decides", () => {
    expect(parsePrompt(`${promptText({ kind: "rename", studentId: 7 }, "Olena")}\nhint`)).toEqual({ kind: "rename", studentId: 7 });
    expect(parsePrompt(`${newStudentPrompt(12)}\nhint`)).toEqual({ kind: "new_student", paymentId: 12 });
  });

  test.each([
    "New name for student #x (A):",
    "New name for student #1 (A)",
    "Name for the new student (payment #12345678901234567):",
    "New name for student #9007199254740992 (A):",
    "Name for the new student (payment #9007199254740992):",
    "Calendar name to add for student #x (A):",
    "Calendar name to add for student #9007199254740992 (A):",
    "hello",
    "",
  ])("%j -> null", (text) => {
    expect(parsePrompt(text)).toBeNull();
  });
});
