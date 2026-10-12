import { describe, expect, it } from "vitest";
import { readLessonCalendarsConfig, type Env } from "../src/config";

const env = (LESSON_CALENDARS?: string): Env => ({ LESSON_CALENDARS });

describe("readLessonCalendarsConfig", () => {
  it("parses entries, trims labels and rewrites only a leading webcal://", () => {
    const result = readLessonCalendarsConfig(
      env(
        JSON.stringify([
          { label: "B2-C1", url: "webcal://p1-caldav.example/x.ics" },
          { label: " A1-A2 ", url: "HTTPS://p2.example/y.ics" },
          { label: "B2", url: "WebCal://p3.example/z.ics" },
        ]),
      ),
    );
    expect(result).toEqual({
      ok: true,
      calendars: [
        { label: "B2-C1", url: "https://p1-caldav.example/x.ics" },
        { label: "A1-A2", url: "HTTPS://p2.example/y.ics" },
        { label: "B2", url: "https://p3.example/z.ics" },
      ],
    });
  });

  const good = { label: "B2", url: "https://secret-host.example/private.ics" };
  const cases: [string, string | undefined, string | null][] = [
    ["missing", undefined, null],
    ["blank", "   ", null],
    ["not JSON", "{nope", null],
    ["not an array", JSON.stringify({ label: "B2", url: "https://secret-host.example/a.ics" }), null],
    ["empty array", "[]", null],
    ["entry not an object", JSON.stringify([good, "https://secret-host.example/b.ics"]), "entry 1"],
    ["entry null", JSON.stringify([null]), "entry 0"],
    ["missing label", JSON.stringify([{ url: good.url }]), "entry 0"],
    ["non-string label", JSON.stringify([{ label: 5, url: good.url }]), "entry 0"],
    ["blank label", JSON.stringify([{ label: "  ", url: good.url }]), "entry 0"],
    ["label over 32 characters", JSON.stringify([{ label: "x".repeat(33), url: good.url }]), "entry 0"],
    ["missing url", JSON.stringify([good, { label: "A1" }]), "entry 1"],
    ["non-string url", JSON.stringify([{ label: "A1", url: 7 }]), "entry 0"],
    ["http scheme", JSON.stringify([{ label: "A1", url: "http://secret-host.example/c.ics" }]), "entry 0"],
    ["ftp scheme", JSON.stringify([{ label: "A1", url: "ftp://secret-host.example/c.ics" }]), "entry 0"],
    ["not a url", JSON.stringify([{ label: "A1", url: "secret-host.example/c.ics" }]), "entry 0"],
    [
      "duplicate label ignoring case",
      JSON.stringify([good, { label: "b2", url: "https://secret-host.example/d.ics" }]),
      "entry 1",
    ],
  ];

  it.each(cases)("rejects %s", (_name, value, entry) => {
    const result = readLessonCalendarsConfig(env(value));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.startsWith("LESSON_CALENDARS:")).toBe(true);
    if (entry) expect(result.error).toContain(entry);
    expect(result.error).not.toContain("secret-host");
    expect(result.error).not.toContain("private.ics");
  });

  it("accepts a label of exactly 32 characters", () => {
    const label = "x".repeat(32);
    const result = readLessonCalendarsConfig(env(JSON.stringify([{ label, url: "https://a.example/a.ics" }])));
    expect(result.ok).toBe(true);
  });
});
