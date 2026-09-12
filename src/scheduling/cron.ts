import { CronDate, CronExpressionParser } from "cron-parser";
import type { ScheduledTask } from "./types.js";

export function scheduleHasEnded(task: Pick<ScheduledTask, "endAt">, now = Date.now()): boolean {
  return task.endAt !== undefined && now >= task.endAt;
}
export function scheduleHasStarted(task: Pick<ScheduledTask, "startAt">, now = Date.now()): boolean {
  return task.startAt === undefined || now >= task.startAt;
}

export function parseStartAt(value: string, timezone: string): number { return parseScheduleDate(value, timezone, "start"); }
export function parseEndAt(value: string, timezone: string): number { return parseScheduleDate(value, timezone, "end"); }

/** Local date-times use the schedule timezone; an explicit offset fixes the instant. */
function parseScheduleDate(value: string, timezone: string, label: "start" | "end"): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/i.exec(value.trim());
  const invalid = `Use a valid ${label} date and time: YYYY-MM-DD HH:mm in the schedule timezone, or ISO 8601 with an offset.`;
  if (!match) throw new Error(invalid);
  const [, year, month, day, hour, minute, second = "00", fraction = "0", offset] = match;
  const milliseconds = fraction.padEnd(3, "0");
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds}`;
  const components = [year, month, day, hour, minute, second, milliseconds].map(Number);
  const matches = (date: CronDate) => [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]
    .every((part, i) => part === components[i]);
  let date: CronDate;
  try {
    // Reject normalized dates such as 24:00, even when an offset was supplied.
    if (!matches(new CronDate(local, "UTC"))) throw new Error(invalid);
    date = new CronDate(`${local}${offset?.toUpperCase() ?? ""}`, timezone);
  } catch { throw new Error(invalid); }
  if (!offset) {
    if (!matches(date)) throw new Error(`That local ${label} time does not exist because of a clock change. Choose another time or include a UTC offset.`);
    // A repeated local time must identify which side of the clock change to use.
    for (const delta of [-86_400_000, 86_400_000]) {
      const otherOffset = new CronDate(new Date(date.getTime() + delta), timezone).getUTCOffset();
      const alternative = new CronDate(new Date(date.getTime() + (date.getUTCOffset() - otherOffset) * 60_000), timezone);
      if (alternative.getTime() !== date.getTime() && matches(alternative)) {
        throw new Error(`That local ${label} time occurs twice because of a clock change. Include a UTC offset, such as -04:00 or -05:00.`);
      }
    }
  }
  return date.getTime();
}

export function nextOccurrences(cron: string, timezone: string, from = Date.now(), count = 3, startAt?: number): number[] {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error("Use a five-field cron expression (minute hour day month weekday).");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw new Error("Use an IANA timezone, such as America/New_York or UTC."); }
  // Cron iteration is exclusive; move back 1 ms to include an occurrence at the start.
  const cursor = startAt !== undefined && startAt >= from ? startAt - 1 : from;
  const expression = CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(cursor) });
  return Array.from({ length: count }, () => expression.next().getTime());
}
export function validateSchedule(cron: string, timezone: string, minimumMs: number, now = Date.now(), startAt?: number): number {
  // The runtime start limit also enforces this across DST and unusually sparse calendars.
  const dates = nextOccurrences(cron, timezone, now, 32, startAt);
  if (dates.some((date, i) => i > 0 && date - dates[i - 1] < minimumMs)) {
    throw new Error(`Schedules must be at least ${minimumMs / 60_000} minutes apart.`);
  }
  return dates[0];
}
export function scheduleDescription(cron: string, timezone: string): string {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === "*" && month === "*") {
    const when = weekday === "*" ? "Every day" : weekday === "1-5" ? "Every weekday" : `On weekday ${weekday}`;
    return `${when} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} (${timezone})`;
  }
  return `Minutes ${minute}; hours ${hour}; day of month ${day}; months ${month}; weekdays ${weekday} (${timezone})`;
}
