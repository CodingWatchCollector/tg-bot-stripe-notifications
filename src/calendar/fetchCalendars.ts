import type { CalendarSource } from "../config";
import type { Occurrence } from "../domain/calendar";
import { readOccurrences, sortOccurrences, type InvalidEvent, type Window } from "./occurrences";

export const DEFAULT_CALENDAR_TIMEOUT_MS = 10_000;

export type CalendarFailure = {
  label: string;
  reason: "network" | "timeout" | "unparsable" | `http ${number}`;
};

type Loaded =
  | { label: string; occurrences: Occurrence[]; invalidEvents: InvalidEvent[] }
  | { label: string; failure: CalendarFailure["reason"] };

// Failure reasons are fixed phrases: urls are secrets and library messages may echo them.
async function load(
  calendar: CalendarSource,
  window: Window,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Loaded> {
  const { label } = calendar;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let body: string;
    try {
      const response = await fetcher(calendar.url, { signal: controller.signal });
      if (!response.ok) return { label, failure: `http ${response.status}` };
      body = await response.text();
    } catch {
      return { label, failure: timedOut ? "timeout" : "network" };
    }
    try {
      return { label, ...readOccurrences(body, label, window) };
    } catch {
      return { label, failure: "unparsable" };
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function readLessonCalendars(
  calendars: readonly CalendarSource[],
  window: Window,
  deps: { fetch: typeof fetch; timeoutMs?: number },
): Promise<{
  occurrences: Occurrence[];
  failed: CalendarFailure[];
  invalidEvents: (InvalidEvent & { label: string })[];
}> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS;
  const loaded = await Promise.all(calendars.map((c) => load(c, window, deps.fetch, timeoutMs)));
  const occurrences: Occurrence[] = [];
  const failed: CalendarFailure[] = [];
  const invalidEvents: (InvalidEvent & { label: string })[] = [];
  for (const item of loaded) {
    if ("failure" in item) {
      failed.push({ label: item.label, reason: item.failure });
      continue;
    }
    occurrences.push(...item.occurrences);
    invalidEvents.push(...item.invalidEvents.map((e) => ({ ...e, label: item.label })));
  }
  return { occurrences: sortOccurrences(occurrences), failed, invalidEvents };
}
