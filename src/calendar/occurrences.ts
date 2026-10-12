import ICAL from "ical.js";
import { occurrenceKey, type Occurrence } from "../domain/calendar";

export type InvalidReason = "missing UID" | "missing DTSTART" | "unknown TZID" | "floating time" | "invalid event";

export interface InvalidEvent {
  uid: string | null;
  reason: InvalidReason;
}

export class CalendarParseError extends Error {}

export interface Window {
  from: Date;
  to: Date;
}

class InvalidEventError extends Error {
  constructor(readonly reason: InvalidReason) {
    super(reason);
  }
}

const PARIS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Paris",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

function parisOffsetMs(instant: number): number {
  const dateParts = PARIS.formatToParts(new Date(instant));
  const part = (type: string): number =>
    Number(dateParts.find((p) => p.type === type)?.value);
  const local = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return local - Math.floor(instant / 1000) * 1000;
}

function parisMidnight(year: number, month: number, day: number): number {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - parisOffsetMs(wall);
  return wall - parisOffsetMs(first);
}

// Never `toJSDate()`: it reads floating times in the process time zone.
function instant(time: ICAL.Time): number {
  if (time.isDate) return parisMidnight(time.year, time.month, time.day);
  return time.toUnixTime() * 1000;
}

function checkTime(prop: ICAL.Property | null): void {
  if (!prop) return;
  const value = prop.getFirstValue();
  if (!(value instanceof ICAL.Time)) throw new InvalidEventError("invalid event");
  if (value.isDate) return;
  const zone = value.zone;
  const bound = zone && zone !== ICAL.Timezone.localTimezone;
  if (prop.getParameter("tzid") !== undefined) {
    if (!bound) throw new InvalidEventError("unknown TZID");
  } else if (zone !== ICAL.Timezone.utcTimezone) {
    throw new InvalidEventError("floating time");
  }
}

function validate(vevent: ICAL.Component): string {
  const uid = vevent.getFirstPropertyValue("uid");
  if (typeof uid !== "string" || !uid) throw new InvalidEventError("missing UID");
  if (!vevent.hasProperty("dtstart")) throw new InvalidEventError("missing DTSTART");
  checkTime(vevent.getFirstProperty("dtstart"));
  checkTime(vevent.getFirstProperty("dtend"));
  checkTime(vevent.getFirstProperty("recurrence-id"));
  return uid;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const compare = (a: Occurrence, b: Occurrence): number => {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  const ka = occurrenceKey(a);
  const kb = occurrenceKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

export const sortOccurrences = (occurrences: Occurrence[]): Occurrence[] => occurrences.sort(compare);

function parse(ics: string): ICAL.Component {
  const body = ics.replace(/^[\uFEFF\s]+/, "");
  if (!/^BEGIN:VCALENDAR/i.test(body)) throw new CalendarParseError("not an iCalendar body");
  try {
    const jcal = ICAL.parse(body);
    if (!Array.isArray(jcal) || jcal[0] !== "vcalendar") throw new CalendarParseError("not a VCALENDAR");
    return new ICAL.Component(jcal);
  } catch (error) {
    if (error instanceof CalendarParseError) throw error;
    throw new CalendarParseError("iCalendar body could not be parsed");
  }
}

export function readOccurrences(
  ics: string,
  label: string,
  window: Window,
): { occurrences: Occurrence[]; invalidEvents: InvalidEvent[] } {
  const root = parse(ics);
  const from = window.from.getTime();
  const to = window.to.getTime();
  const invalidEvents: InvalidEvent[] = [];
  const occurrences: Occurrence[] = [];

  const masters = new Map<string, ICAL.Component[]>();
  const overrides = new Map<string, ICAL.Component[]>();
  for (const vevent of root.getAllSubcomponents("vevent")) {
    let uid: string;
    try {
      uid = validate(vevent);
    } catch (error) {
      const raw = vevent.getFirstPropertyValue("uid");
      invalidEvents.push({
        uid: typeof raw === "string" && raw ? raw : null,
        reason: error instanceof InvalidEventError ? error.reason : "invalid event",
      });
      continue;
    }
    const group = vevent.hasProperty("recurrence-id") ? overrides : masters;
    group.set(uid, [...(group.get(uid) ?? []), vevent]);
  }

  const emit = (
    uid: string,
    item: ICAL.Event,
    fallbackTitle: string,
    originalStart: number,
    start: ICAL.Time,
    end: ICAL.Time,
  ): void => {
    const startMs = instant(start);
    const endMs = instant(end);
    if (!(startMs < to && endMs > from)) return;
    occurrences.push({
      calendar: label,
      uid,
      originalStart: iso(originalStart),
      start: iso(startMs),
      end: iso(endMs),
      title: (item.summary ?? fallbackTitle).trim(),
      allDay: start.isDate,
    });
  };

  const emitOverride = (uid: string, component: ICAL.Component, fallbackTitle: string): void => {
    const exception = new ICAL.Event(component);
    emit(uid, exception, fallbackTitle, instant(exception.recurrenceId), exception.startDate, exception.endDate);
  };

  const guarded = (uid: string, work: () => void): void => {
    const before = occurrences.length;
    try {
      work();
    } catch {
      occurrences.length = before;
      invalidEvents.push({ uid, reason: "invalid event" });
    }
  };

  for (const [uid, group] of masters) {
    const related = overrides.get(uid) ?? [];
    for (const component of group) {
      guarded(uid, () => {
        const event = new ICAL.Event(component, { strictExceptions: true, exceptions: related });
        const title = event.summary ?? "";
        if (!event.isRecurring()) {
          emit(uid, event, title, instant(event.startDate), event.startDate, event.endDate);
          return;
        }
        const expansion = event.iterator();
        for (let next = expansion.next(); next; next = expansion.next()) {
          const original = instant(next);
          if (original >= to) break;
          const details = event.getOccurrenceDetails(next);
          emit(uid, details.item, title, original, details.startDate, details.endDate);
        }
        for (const other of related) {
          if (instant(new ICAL.Event(other).recurrenceId) >= to) emitOverride(uid, other, title);
        }
      });
    }
  }

  for (const [uid, group] of overrides) {
    if (masters.has(uid)) continue;
    for (const component of group) {
      guarded(uid, () => emitOverride(uid, component, ""));
    }
  }

  return { occurrences: sortOccurrences(occurrences), invalidEvents };
}
