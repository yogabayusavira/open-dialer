// Opening hours from a lead's CSV column, as Google Maps exports write them, and whether the place is open now.
// Understands "Monday: 8 AM–5 PM; Tuesday: …", "Mon-Fri 8am-5pm, Sat 9-1", "Sunday: Closed", "Open 24 hours",
// several ranges a day ("8 AM–12 PM, 1–5 PM"), JSON like {"Monday": "8AM-5PM"} or [{"day": "Monday", "hours": "…"}].
// Days are 0 = Sunday … 6 = Saturday; times are minutes after midnight in the business's own time.

type Range = [number, number];
export type WeekHours = Map<number, Range[]>;

const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayOf(word: string) {
  const index = dayKeys.indexOf(word.trim().toLowerCase().slice(0, 3));
  return index < 0 ? null : index;
}

// "8", "8am", "8:30 PM", "17:00", "noon", "midnight" → minutes, and whether am/pm was written.
function timeOf(text: string): { minutes: number; meridiem: boolean } | null {
  const value = text.trim().toLowerCase().replace(/\./g, "");
  if (value === "noon") return { minutes: 720, meridiem: true };
  if (value === "midnight") return { minutes: 0, meridiem: true };
  const match = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour > 24 || minute > 59) return null;
  if (match[3]?.startsWith("p") && hour < 12) hour += 12;
  if (match[3]?.startsWith("a") && hour === 12) hour = 0;
  return { minutes: hour * 60 + minute, meridiem: Boolean(match[3]) };
}

function rangesOf(text: string): Range[] | null {
  const value = text.trim().toLowerCase();
  if (/^closed/.test(value)) return [];
  if (/24\s*(hours|hrs|h)|open 24/.test(value)) return [[0, 1440]];
  const ranges: Range[] = [];
  for (const part of value.split(/\s*,\s*|\s+and\s+/)) {
    const [from, to] = part.split(/\s*(?:–|—|-|to)\s*/);
    if (!from || !to) continue;
    // "1–5 PM": the am/pm written on the closing time also applies to the opening one.
    const closeText = to.trim();
    const openText = /\d$/.test(from.trim()) && /(am|pm)$/.test(closeText) ? `${from.trim()} ${closeText.slice(-2)}` : from;
    const open = timeOf(openText);
    const close = timeOf(closeText);
    if (!open || !close) continue;
    let end = close.minutes === 0 ? 1440 : close.minutes;
    // Plain numbers like "8-5" mean 8 AM to 5 PM.
    if (!close.meridiem && !open.meridiem && end <= open.minutes && end + 720 <= 1440) end += 720;
    ranges.push([open.minutes, end]);
  }
  return ranges.length ? ranges : null;
}

export function parseHours(raw: string): WeekHours | null {
  const text = raw.trim();
  if (!text) return null;
  const week: WeekHours = new Map();
  const add = (days: number[], ranges: Range[] | null) => { if (ranges) for (const day of days) week.set(day, ranges); };
  // JSON from scrapers: {"Monday": "8AM-5PM"} or [{"day": "Monday", "hours": "8AM-5PM"}].
  if (/^[[{]/.test(text)) {
    try {
      const data = JSON.parse(text);
      const entries: [string, unknown][] = Array.isArray(data) ? data.map((item) => [String(item?.day ?? ""), item?.hours]) : Object.entries(data);
      for (const [day, hours] of entries) {
        const index = dayOf(day);
        if (index !== null) add([index], rangesOf(Array.isArray(hours) ? hours.join(", ") : String(hours ?? "")));
      }
      return week.size ? week : null;
    } catch { /* not JSON after all; read it as text */ }
  }
  if (/^open 24/i.test(text)) {
    for (let day = 0; day < 7; day++) week.set(day, [[0, 1440]]);
    return week;
  }
  // One segment per day or day range: split at ; | new lines, or at a comma that starts a new day.
  const dayWord = "(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*";
  const segments = text.split(new RegExp(`\\s*[;|\\n]\\s*|,\\s*(?=${dayWord}\\b)`, "i")).filter(Boolean);
  for (const segment of segments) {
    const match = segment.match(new RegExp(`^(${dayWord})(?:\\s*(?:–|—|-|to)\\s*(${dayWord}))?\\s*:?\\s*(.+)$`, "i"));
    if (!match) continue;
    const first = dayOf(match[1]);
    const last = match[2] ? dayOf(match[2]) : first;
    if (first === null || last === null) continue;
    const days: number[] = [];
    for (let day = first; ; day = (day + 1) % 7) { days.push(day); if (day === last || days.length > 7) break; }
    add(days, rangesOf(match[3]));
  }
  return week.size ? week : null;
}

function clockLabel(minutes: number) {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour < 12 ? "AM" : "PM"}`;
}

// Open or closed at this weekday and minute, with when that changes. Ranges past midnight carry into the next day.
export function hoursStatus(week: WeekHours, day: number, minute: number): { open: boolean; text: string } {
  const today = week.get(day) || [];
  const yesterday = week.get((day + 6) % 7) || [];
  if (today.some(([from, to]) => from === 0 && to === 1440)) return { open: true, text: "Open 24 hours" };
  const carried = yesterday.find(([from, to]) => to > 1440 || (to < from && minute < to));
  if (carried && minute < (carried[1] > 1440 ? carried[1] - 1440 : carried[1])) return { open: true, text: `Open now · closes ${clockLabel(carried[1] % 1440)}` };
  for (const [from, to] of today) {
    const end = to < from ? to + 1440 : to;
    if (minute >= from && minute < end) return { open: true, text: `Open now · closes ${clockLabel(end % 1440)}` };
  }
  const later = today.filter(([from]) => from > minute).sort((a, b) => a[0] - b[0])[0];
  if (later) return { open: false, text: `Closed · opens ${clockLabel(later[0])}` };
  for (let ahead = 1; ahead <= 7; ahead++) {
    const next = (week.get((day + ahead) % 7) || []).slice().sort((a, b) => a[0] - b[0])[0];
    if (next) return { open: false, text: `Closed · opens ${ahead === 1 ? "tomorrow" : dayLabels[(day + ahead) % 7]} ${clockLabel(next[0])}` };
  }
  return { open: false, text: "Closed" };
}

// The weekday and minute right now in a time zone, e.g. America/Chicago.
export function nowIn(zone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { day: dayOf(get("weekday")) ?? 0, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}
