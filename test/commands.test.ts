import { describe, expect, test } from "vitest";
import { COMMANDS, helpText } from "../src/app/commands";

describe("COMMANDS", () => {
  test("fit Telegram's limits for a command menu", () => {
    for (const c of COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThanOrEqual(1);
      expect(c.description.length).toBeLessThanOrEqual(256);
      expect(c.usage.startsWith(`/${c.command}`)).toBe(true);
    }
    expect(new Set(COMMANDS.map((c) => c.command)).size).toBe(COMMANDS.length);
    expect(COMMANDS.length).toBeLessThanOrEqual(100);
  });
});

describe("helpText", () => {
  test("lists every command with its usage", () => {
    const text = helpText();
    for (const c of COMMANDS) expect(text).toContain(`${c.usage} - ${c.description}`);
  });
});
