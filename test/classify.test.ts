import { describe, expect, it } from "vitest";
import { classifyOccurrence, occurrenceKey, titleKey, type Classification } from "../src/domain/calendar";

describe("titleKey", () => {
  it("ignores case, outer spaces and repeated spaces", () => {
    expect(titleKey(" duo b2/c1  (mira k,  yeva) ")).toBe(titleKey("Duo B2/C1 (Mira K, Yeva)"));
    expect(titleKey("marko ")).toBe(titleKey("Marko"));
  });

  it("treats NFC and NFD spellings as one", () => {
    expect(titleKey("\u0407")).toBe(titleKey("\u0406\u0308"));
  });

  it("keeps different names apart", () => {
    expect(titleKey("Mira K")).not.toBe(titleKey("MiraK"));
    expect(titleKey("Marko")).not.toBe(titleKey("Marka"));
  });
});

describe("classifyOccurrence", () => {
  const titles = {
    attached: new Map<string, readonly number[]>([
      [titleKey("Marko"), [3]],
      [titleKey("Duo B2/C1 (Mira K, Yeva)"), [6, 5]],
    ]),
    ignored: new Set([titleKey("Пробне заняття")]),
  };
  const classify = (title: string, allDay = false): Classification =>
    classifyOccurrence({ title, allDay }, titles);

  const cases: [string, string, boolean, Classification][] = [
    ["all-day", "Marko", true, { kind: "skip", reason: "all_day" }],
    ["contract", "Marko (підрядниця)", false, { kind: "skip", reason: "contract" }],
    ["contract, upper case, cancelled", "❌ Marko (ПІДРЯДНИЦЯ) — відміна", false, { kind: "skip", reason: "contract" }],
    ["cancelled", "❌ Marko — відміна", false, { kind: "cancelled", titleKey: "marko", studentIds: [3] }],
    ["cancelled with U+FE0F", "\u274C\uFE0F Marko — відміна", false, { kind: "cancelled", titleKey: "marko", studentIds: [3] }],
    ["cancelled without a space", "❌Marko", false, { kind: "cancelled", titleKey: "marko", studentIds: [3] }],
    [
      "cancelled, matches nobody",
      "❌ Nobody — перенесено на пт 9.10",
      false,
      { kind: "cancelled", titleKey: "nobody", studentIds: [] },
    ],
    ["bare mark", "❌", false, { kind: "cancelled", titleKey: "", studentIds: [] }],
    ["mark and reason only", "❌ — відміна", false, { kind: "cancelled", titleKey: "", studentIds: [] }],
    ["cancelled ignored title", "❌ Пробне заняття — відміна", false, { kind: "skip", reason: "ignored" }],
    [
      "unattached keeps the title as written",
      " \u0406\u0308 Taras ",
      false,
      { kind: "unattached", titleKey: "\u0457 taras", title: "\u0406\u0308 Taras" },
    ],
    ["ignored", "Пробне заняття", false, { kind: "skip", reason: "ignored" }],
    ["lesson", "marko", false, { kind: "lesson", titleKey: "marko", studentIds: [3] }],
    [
      "shared lesson keeps the given order",
      "Duo B2/C1 (Mira K, Yeva)",
      false,
      { kind: "lesson", titleKey: titleKey("Duo B2/C1 (Mira K, Yeva)"), studentIds: [6, 5] },
    ],
    ["unattached", " Taras ", false, { kind: "unattached", titleKey: "taras", title: "Taras" }],
  ];

  it.each(cases)("%s", (_name, title, allDay, expected) => {
    expect(classify(title, allDay)).toEqual(expected);
  });
});

describe("occurrenceKey", () => {
  it("joins uid and original start", () => {
    expect(occurrenceKey({ uid: "a@test", originalStart: "2026-10-20T16:00:00.000Z" })).toBe(
      "a@test|2026-10-20T16:00:00.000Z",
    );
  });
});
