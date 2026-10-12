import { describe, expect, it } from "vitest";
import { DEFAULT_CALENDAR_TIMEOUT_MS, readLessonCalendars } from "../src/calendar/fetchCalendars";
import { calendar, weeklyTuesday, window } from "./support/calendar";

const W = window("2026-10-05T00:00:00Z", "2026-10-26T00:00:00Z");
const feed = (uid: string, summary: string): string => calendar([weeklyTuesday(uid, [], summary)]);
const ok = (body: string): Response => new Response(body, { status: 200 });

describe("readLessonCalendars", () => {
  it("fetches every calendar concurrently and merges the occurrences", { timeout: 1000 }, async () => {
    const calendars = [
      { label: "B2-C1", url: "https://one.example/1.ics" },
      { label: "A1-A2", url: "https://two.example/2.ics" },
      { label: "B2", url: "https://three.example/3.ics" },
    ];
    const bodies: Record<string, string> = {
      "https://one.example/1.ics": feed("one@test", "One"),
      "https://two.example/2.ics": feed("two@test", "Two"),
      "https://three.example/3.ics": feed("three@test", "Three"),
    };
    const calls: { url: string; signal: unknown }[] = [];
    let release!: () => void;
    const allCalled = new Promise<void>((resolve) => (release = resolve));
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal });
      if (calls.length === calendars.length) release();
      await allCalled;
      return ok(bodies[String(input)] ?? "");
    }) as typeof fetch;

    const result = await readLessonCalendars(calendars, W, { fetch: fakeFetch });

    expect(calls.map((c) => c.url)).toEqual(calendars.map((c) => c.url));
    expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.invalidEvents).toEqual([]);
    expect(result.occurrences).toHaveLength(9);
    const byLabel = (label: string) => result.occurrences.filter((o) => o.calendar === label).map((o) => o.title);
    expect(byLabel("B2-C1")).toEqual(["One", "One", "One"]);
    expect(byLabel("A1-A2")).toEqual(["Two", "Two", "Two"]);
    expect(byLabel("B2")).toEqual(["Three", "Three", "Three"]);
    expect(result.occurrences.map((o) => o.uid)).toEqual([
      "one@test",
      "three@test",
      "two@test",
      "one@test",
      "three@test",
      "two@test",
      "one@test",
      "three@test",
      "two@test",
    ]);
  });

  it("reports failures by label and still loads the others", async () => {
    const calendars = ["http503", "network", "timeout", "html", "good"].map((label) => ({
      label,
      url: `https://${label}.secret.example/private.ics`,
    }));
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("http503")) return new Response("no", { status: 503 });
      if (url.includes("network")) throw new TypeError("connect ECONNREFUSED secret.example");
      if (url.includes("timeout")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      if (url.includes("html")) return ok("<html>login</html>");
      return ok(feed("good@test", "Good"));
    }) as typeof fetch;

    const result = await readLessonCalendars(calendars, W, { fetch: fakeFetch, timeoutMs: 20 });

    expect(result.failed).toEqual([
      { label: "http503", reason: "http 503" },
      { label: "network", reason: "network" },
      { label: "timeout", reason: "timeout" },
      { label: "html", reason: "unparsable" },
    ]);
    expect(JSON.stringify(result.failed)).not.toContain("secret");
    expect(result.occurrences.map((o) => o.calendar)).toEqual(["good", "good", "good"]);
    expect(DEFAULT_CALENDAR_TIMEOUT_MS).toBe(10000);
  });

  it("reports invalid events with the calendar label without failing it", async () => {
    const body = calendar([weeklyTuesday("good@test"), ["UID:bad-1@test", "SUMMARY:x", "DTEND:20261021T110000Z"]]);
    const result = await readLessonCalendars([{ label: "B2", url: "https://a.example/a.ics" }], W, {
      fetch: (async () => ok(body)) as typeof fetch,
    });
    expect(result.failed).toEqual([]);
    expect(result.invalidEvents).toEqual([{ label: "B2", uid: "bad-1@test", reason: "missing DTSTART" }]);
    expect(result.occurrences).toHaveLength(3);
  });

  it("resolves with unparsable when reading the feed throws an unexpected error", async () => {
    const brokenWindow = {
      from: { getTime: () => { throw new Error("boom https://secret.example/x.ics"); } } as unknown as Date,
      to: W.to,
    };
    const result = await readLessonCalendars([{ label: "B2", url: "https://a.example/a.ics" }], brokenWindow, {
      fetch: (async () => ok(feed("good@test", "Good"))) as typeof fetch,
    });
    expect(result.failed).toEqual([{ label: "B2", reason: "unparsable" }]);
    expect(result.occurrences).toEqual([]);
  });
});
