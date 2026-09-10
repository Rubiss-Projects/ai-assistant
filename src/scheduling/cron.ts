import { CronExpressionParser } from "cron-parser";

export function nextOccurrences(cron: string, timezone: string, from = Date.now(), count = 3): number[] {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error("Use a five-field cron expression (minute hour day month weekday).");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw new Error("Use an IANA timezone, such as America/New_York or UTC."); }
  const expression = CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(from) });
  return Array.from({ length: count }, () => expression.next().getTime());
}
export function validateSchedule(cron: string, timezone: string, minimumMs: number, now = Date.now()): number {
  // The runtime start limit also enforces this across DST and unusually sparse calendars.
  const dates = nextOccurrences(cron, timezone, now, 32);
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
