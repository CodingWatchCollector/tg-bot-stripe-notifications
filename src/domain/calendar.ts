import { nameKey } from "./student";

export interface Occurrence {
  calendar: string;
  uid: string;
  originalStart: string;
  start: string;
  end: string;
  title: string;
  allDay: boolean;
}

export const occurrenceKey = (o: Pick<Occurrence, "uid" | "originalStart">): string => `${o.uid}|${o.originalStart}`;

export type Classification =
  | { kind: "skip"; reason: "all_day" | "contract" | "ignored" }
  | { kind: "cancelled"; titleKey: string; studentIds: number[] }
  | { kind: "lesson"; titleKey: string; studentIds: number[] }
  | { kind: "unattached"; titleKey: string; title: string };

export const titleKey = (title: string): string => nameKey(title.normalize("NFC"));

const CONTRACT_MARK = "(підрядниця)";
const CANCEL_MARK = /^\u274C\uFE0F?/;
const CANCEL_SEPARATOR = " — ";

export function classifyOccurrence(
  o: Pick<Occurrence, "title" | "allDay">,
  titles: { attached: ReadonlyMap<string, readonly number[]>; ignored: ReadonlySet<string> },
): Classification {
  if (o.allDay) return { kind: "skip", reason: "all_day" };
  const title = o.title.trim();
  const text = title.normalize("NFC");
  if (text.toLowerCase().includes(CONTRACT_MARK)) return { kind: "skip", reason: "contract" };

  const cancelled = CANCEL_MARK.exec(text);
  if (cancelled) {
    const rest = text.slice(cancelled[0].length);
    const end = rest.indexOf(CANCEL_SEPARATOR);
    const key = titleKey(end === -1 ? rest : rest.slice(0, end));
    if (titles.ignored.has(key)) return { kind: "skip", reason: "ignored" };
    return { kind: "cancelled", titleKey: key, studentIds: [...(titles.attached.get(key) ?? [])] };
  }

  const key = titleKey(text);
  if (titles.ignored.has(key)) return { kind: "skip", reason: "ignored" };
  const ids = titles.attached.get(key);
  if (ids) return { kind: "lesson", titleKey: key, studentIds: [...ids] };
  return { kind: "unattached", titleKey: key, title };
}
