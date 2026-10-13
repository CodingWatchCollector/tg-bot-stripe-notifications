import { describe, expect, test } from "vitest";
import { isValidCalendarName } from "../src/domain/calendar";

describe("isValidCalendarName", () => {
  test.each([
    ["a plain name", "Marko"],
    ["100 code points", "\u0416".repeat(100)],
    ["padding", "  Marko  "],
    ["a title with spaces and slashes", "Duo B2/C1 (Mira K, Yeva)"],
  ])("accepts %s", (_n, text) => {
    expect(isValidCalendarName(text)).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["101 code points", "\u0416".repeat(101)],
    ["a leading cancel mark", "\u274C Marko"],
    ["a cancel mark with a variation selector", "\u274C\uFE0F Marko"],
    ["a cancel mark after padding", "  \u274C Marko"],
    ["the contract marker in upper case", "Marko (\u041F\u0406\u0414\u0420\u042F\u0414\u041D\u0418\u0426\u042F)"],
    ["the cancel separator", "Marko \u2014 extra"],
  ])("rejects %s", (_n, text) => {
    expect(isValidCalendarName(text)).toBe(false);
  });

  test("counts code points, not UTF-16 units", () => {
    expect(isValidCalendarName("\u{1F600}".repeat(100))).toBe(true);
    expect(isValidCalendarName("\u{1F600}".repeat(101))).toBe(false);
  });
});
