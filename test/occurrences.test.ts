import { describe, expect, it } from "vitest";
import main from "./fixtures/calendars/main.ics?raw";
import { CalendarParseError, readOccurrences } from "../src/calendar/occurrences";
import { occurrenceKey } from "../src/domain/calendar";
import { PARIS_VTIMEZONE, calendar, weeklyTuesday, window } from "./support/calendar";

const read = (ics: string, from: string, to: string, label = "B2") => readOccurrences(ics, label, window(from, to));
const starts = (ics: string, from: string, to: string) =>
  read(ics, from, to).occurrences.map((o) => o.start);

describe("test process time zone", () => {
  it("is pinned to America/New_York", () => {
    expect(process.env.TZ).toBe("America/New_York");
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(300);
  });
});

describe("single events", () => {
  it("reads Paris and UTC times", () => {
    const ics = calendar([
      [
        "UID:paris@test",
        "SUMMARY:Marko",
        "DTSTART;TZID=Europe/Paris:20261021T100000",
        "DTEND;TZID=Europe/Paris:20261021T110000",
      ],
      ["UID:utc@test", "SUMMARY:Mira K", "DTSTART:20261021T150000Z", "DTEND:20261021T160000Z"],
    ]);
    const { occurrences, invalidEvents } = read(ics, "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z");
    expect(invalidEvents).toEqual([]);
    expect(occurrences).toEqual([
      {
        calendar: "B2",
        uid: "paris@test",
        title: "Marko",
        allDay: false,
        start: "2026-10-21T08:00:00.000Z",
        end: "2026-10-21T09:00:00.000Z",
        originalStart: "2026-10-21T08:00:00.000Z",
      },
      {
        calendar: "B2",
        uid: "utc@test",
        title: "Mira K",
        allDay: false,
        start: "2026-10-21T15:00:00.000Z",
        end: "2026-10-21T16:00:00.000Z",
        originalStart: "2026-10-21T15:00:00.000Z",
      },
    ]);
  });

  it("uses DURATION when DTEND is absent", () => {
    const ics = calendar([
      ["UID:d@test", "SUMMARY:x", "DTSTART;TZID=Europe/Paris:20261021T100000", "DURATION:PT1H30M"],
    ]);
    expect(read(ics, "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z").occurrences[0]?.end).toBe(
      "2026-10-21T09:30:00.000Z",
    );
  });

  it.each([true, false])("reads an all-day event as Paris midnights (VTIMEZONE: %s)", (timezone) => {
    const ics = calendar(
      [["UID:day@test", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261022"]],
      { timezone },
    );
    const { occurrences } = read(ics, "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z");
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      allDay: true,
      start: "2026-10-20T22:00:00.000Z",
      end: "2026-10-21T22:00:00.000Z",
    });
  });

  it("returns only events that overlap the window", () => {
    const ics = calendar([
      ["UID:a@test", "SUMMARY:a", "DTSTART;TZID=Europe/Paris:20261018T230000", "DTEND;TZID=Europe/Paris:20261019T030000"],
      ["UID:b@test", "SUMMARY:b", "DTSTART:20261018T220000Z", "DTEND:20261019T000000Z"],
      ["UID:c@test", "SUMMARY:c", "DTSTART:20261026T000000Z", "DTEND:20261026T010000Z"],
    ]);
    expect(read(ics, "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z").occurrences.map((o) => o.uid)).toEqual([
      "a@test",
    ]);
  });
});

describe("weekly series", () => {
  const W = ["2026-10-05T00:00:00Z", "2026-10-26T00:00:00Z"] as const;

  it("expands without UNTIL", () => {
    const o = read(calendar([weeklyTuesday()]), ...W).occurrences;
    expect(o.map((x) => x.start)).toEqual([
      "2026-10-06T08:00:00.000Z",
      "2026-10-13T08:00:00.000Z",
      "2026-10-20T08:00:00.000Z",
    ]);
    expect(o.every((x) => x.originalStart === x.start)).toBe(true);
  });

  it("includes the occurrence that starts exactly at UNTIL", () => {
    const ics = calendar([
      [
        "UID:u@test",
        "SUMMARY:Marko",
        "DTSTART;TZID=Europe/Paris:20260901T100000",
        "DTEND;TZID=Europe/Paris:20260901T110000",
        "RRULE:FREQ=WEEKLY;UNTIL=20261013T080000Z",
      ],
    ]);
    expect(starts(ics, ...W)).toEqual(["2026-10-06T08:00:00.000Z", "2026-10-13T08:00:00.000Z"]);
  });

  it("drops an EXDATE", () => {
    const ics = calendar([weeklyTuesday("w@test", ["EXDATE;TZID=Europe/Paris:20261013T100000"])]);
    expect(starts(ics, ...W)).toEqual(["2026-10-06T08:00:00.000Z", "2026-10-20T08:00:00.000Z"]);
  });

  it.each([
    ["autumn", "2026-10-13", "2026-10-19T00:00:00Z", "2026-11-02T00:00:00Z", ["2026-10-20T16:00:00.000Z", "2026-10-27T17:00:00.000Z"]],
    ["spring", "2027-03-16", "2027-03-22T00:00:00Z", "2027-04-05T00:00:00Z", ["2027-03-23T17:00:00.000Z", "2027-03-30T16:00:00.000Z"]],
  ])("keeps the Paris wall-clock time across DST (%s)", (_n, first, from, to, expected) => {
    const day = first.replaceAll("-", "");
    const ics = calendar([
      [
        "UID:dst@test",
        "SUMMARY:Marko",
        `DTSTART;TZID=Europe/Paris:${day}T180000`,
        `DTEND;TZID=Europe/Paris:${day}T190000`,
        "RRULE:FREQ=WEEKLY",
      ],
    ]);
    expect(starts(ics, from, to)).toEqual(expected);
  });
});

describe("overrides", () => {
  const W = ["2026-10-05T00:00:00Z", "2026-10-26T00:00:00Z"] as const;
  const override = (uid: string, recurrence: string, lines: string[]): string[] => [
    `UID:${uid}`,
    `RECURRENCE-ID;TZID=Europe/Paris:${recurrence}`,
    ...lines,
  ];
  const paris = (start: string, end: string): string[] => [
    `DTSTART;TZID=Europe/Paris:${start}`,
    `DTEND;TZID=Europe/Paris:${end}`,
  ];

  it("moves an occurrence and keeps the base title", () => {
    const ics = calendar([
      weeklyTuesday("w@test"),
      override("w@test", "20261013T100000", paris("20261015T140000", "20261015T150000")),
    ]);
    const { occurrences } = read(ics, ...W);
    const moved = occurrences.find((o) => o.originalStart === "2026-10-13T08:00:00.000Z");
    expect(moved).toMatchObject({
      start: "2026-10-15T12:00:00.000Z",
      end: "2026-10-15T13:00:00.000Z",
      title: "Marko",
    });
    expect(occurrences.some((o) => o.start === "2026-10-13T08:00:00.000Z")).toBe(false);
  });

  it("renames an occurrence without changing its key", () => {
    const renamed = calendar([
      weeklyTuesday("w@test"),
      override("w@test", "20261013T100000", [
        ...paris("20261013T100000", "20261013T110000"),
        "SUMMARY:❌ Зоряна — відміна",
      ]),
    ]);
    const plain = calendar([weeklyTuesday("w@test")]);
    const pick = (ics: string) => read(ics, ...W).occurrences.find((o) => o.start === "2026-10-13T08:00:00.000Z");
    expect(pick(renamed)?.title).toBe("❌ Зоряна — відміна");
    expect(occurrenceKey(pick(renamed)!)).toBe(occurrenceKey(pick(plain)!));
  });

  it("handles moves in and out of the window", () => {
    const ics = calendar([
      weeklyTuesday("w@test"),
      override("w@test", "20261020T100000", paris("20261027T120000", "20261027T130000")),
      override("w@test", "20261027T100000", paris("20261022T100000", "20261022T110000")),
      override("w@test", "20260929T100000", paris("20261008T100000", "20261008T110000")),
    ]);
    const { occurrences } = read(ics, ...W);
    expect(occurrences.map((o) => [o.start, o.originalStart])).toEqual([
      ["2026-10-06T08:00:00.000Z", "2026-10-06T08:00:00.000Z"],
      ["2026-10-08T08:00:00.000Z", "2026-09-29T08:00:00.000Z"],
      ["2026-10-13T08:00:00.000Z", "2026-10-13T08:00:00.000Z"],
      ["2026-10-22T08:00:00.000Z", "2026-10-27T09:00:00.000Z"],
    ]);
  });

  it("applies an override only to its own UID and orders equal starts by key", () => {
    const ics = calendar([
      weeklyTuesday("b-series@test"),
      weeklyTuesday("a-series@test"),
      override("b-series@test", "20261013T100000", [
        ...paris("20261013T100000", "20261013T110000"),
        "SUMMARY:Renamed",
      ]),
    ]);
    const { occurrences } = read(ics, ...W);
    expect(occurrences.map((o) => [o.uid, o.title])).toEqual([
      ["a-series@test", "Marko"],
      ["b-series@test", "Marko"],
      ["a-series@test", "Marko"],
      ["b-series@test", "Renamed"],
      ["a-series@test", "Marko"],
      ["b-series@test", "Marko"],
    ]);
  });

  it("returns an override without a master on its own times", () => {
    const ics = calendar([
      override("lonely@test", "20261013T100000", [
        ...paris("20261015T140000", "20261015T150000"),
        "SUMMARY:Marko",
      ]),
    ]);
    const { occurrences, invalidEvents } = read(ics, ...W);
    expect(invalidEvents).toEqual([]);
    expect(occurrences).toMatchObject([
      { uid: "lonely@test", start: "2026-10-15T12:00:00.000Z", originalStart: "2026-10-13T08:00:00.000Z" },
    ]);
  });
});

describe("malformed data", () => {
  const W = ["2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z"] as const;

  it.each([
    ["html", "<html><body>nope</body></html>"],
    ["empty", ""],
    ["truncated", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x@test\r\nDTSTART:20261021T100000Z\r\n"],
    ["truncated after header", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"],
    [
      "invalid RRULE",
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x@test\r\nDTSTART:20261021T100000Z\r\nRRULE:FREQ=FOO\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    ],
  ])("throws CalendarParseError for %s", (_n, body) => {
    expect(() => read(body, ...W)).toThrow(CalendarParseError);
  });

  it("accepts a calendar with only a VTIMEZONE, with or without a BOM", () => {
    const tzOnly = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${PARIS_VTIMEZONE}\r\nEND:VCALENDAR\r\n`;
    expect(read(tzOnly, ...W)).toEqual({ occurrences: [], invalidEvents: [] });
    expect(read(`\uFEFF\r\n${tzOnly}`, ...W)).toEqual({ occurrences: [], invalidEvents: [] });
  });

  it("skips and reports invalid events with fixed reasons", () => {
    const ics = calendar([
      weeklyTuesday("good@test"),
      ["UID:bad-1@test", "SUMMARY:Secret One", "DTEND;TZID=Europe/Paris:20261021T110000"],
      ["UID:bad-2@test", "SUMMARY:Secret Two", "DTSTART;TZID=Mars/Olympus:20261021T100000"],
      ["UID:bad-3@test", "SUMMARY:x", "DTSTART:20261021T100000"],
      ["UID:bad-4@test", "SUMMARY:x", "DTSTART:20261021T100000Z", "DTEND;TZID=Mars/Olympus:20261021T110000"],
      ["UID:bad-5@test", "SUMMARY:x", "DTSTART:20261021T100000Z", "DTEND:20261021T110000"],
      ["UID:bad-6@test", "SUMMARY:x", "DTSTART:2026XX21T100000Z"],
      ["SUMMARY:no uid", "DTSTART:20261021T100000Z"],
    ]);
    const { occurrences, invalidEvents } = read(ics, ...W);
    expect(occurrences.map((o) => o.uid)).toEqual(["good@test"]);
    expect(invalidEvents).toHaveLength(7);
    expect(new Set(invalidEvents.map((e) => e.uid))).toEqual(
      new Set(["bad-1@test", "bad-2@test", "bad-3@test", "bad-4@test", "bad-5@test", "bad-6@test", null]),
    );
    const reasons = new Set(["missing UID", "missing DTSTART", "unknown TZID", "floating time", "invalid event"]);
    expect(invalidEvents.every((e) => reasons.has(e.reason))).toBe(true);
    expect(JSON.stringify(invalidEvents)).not.toContain("Secret");
  });
});

describe("main fixture", () => {
  const read2 = () => readOccurrences(main, "B2", window("2026-10-05T00:00:00Z", "2026-11-02T00:00:00Z"));

  it("contains every construct the real feeds use", () => {
    expect(main).toContain("\r\n");
    expect(main).toMatch(/\r\nSUMMARY:[^\r\n]*\r\n [^\r\n]/);
    for (const needle of [
      "PRODID:-//tg-bot//fixtures//EN",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Paris",
      "EXDATE;TZID=Europe/Paris:",
      "RECURRENCE-ID;TZID=Europe/Paris:",
      "RRULE:FREQ=WEEKLY\r\n",
      "RRULE:FREQ=WEEKLY;UNTIL=",
      "DTSTART;VALUE=DATE:",
      "(підрядниця)",
    ]) {
      expect(main).toContain(needle);
    }
  });

  it("unfolds, unescapes and trims titles", () => {
    const { occurrences, invalidEvents } = read2();
    expect(invalidEvents).toEqual([]);
    const titles = new Set(occurrences.map((o) => o.title));
    expect(titles).toEqual(
      new Set([
        "Marko",
        "Duo B2/C1 (Mira K, Yeva)",
        "Taras",
        "Marko (підрядниця)",
        "❌ Зоряна — відміна",
        "Зоряна",
        "Yeva",
        "Mira K - extra lesson with a long title that the calendar app folds over two lines",
        "Public holiday",
      ]),
    );
  });

  it("applies EXDATE, UNTIL, moves and the all-day event", () => {
    const { occurrences } = read2();
    const of = (uid: string) => occurrences.filter((o) => o.uid === uid).map((o) => o.start);
    expect(of("fixture-exdate-1@test")).toEqual(["2026-10-22T09:00:00.000Z", "2026-10-29T10:00:00.000Z"]);
    expect(of("fixture-duo-1@test")).toEqual(["2026-10-07T16:00:00.000Z"]);
    expect(of("fixture-moved-1@test")).toEqual([
      "2026-10-07T15:00:00.000Z",
      "2026-10-16T10:00:00.000Z",
      "2026-10-21T15:00:00.000Z",
      "2026-10-28T16:00:00.000Z",
    ]);
    expect(occurrences.find((o) => o.uid === "fixture-allday-1@test")).toMatchObject({
      allDay: true,
      start: "2026-10-28T23:00:00.000Z",
      end: "2026-10-29T23:00:00.000Z",
    });
  });

  it("gives stable, unique keys of the form uid|originalStart", () => {
    const a = read2().occurrences.map(occurrenceKey);
    const b = read2().occurrences.map(occurrenceKey);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    for (const o of read2().occurrences) expect(occurrenceKey(o)).toBe(`${o.uid}|${o.originalStart}`);
  });
});
