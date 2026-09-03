// shared/businessDays.js — "two business days from now", in the customer's timezone.
//
// The pre-run notice exists so a scheduled search can still be CHANGED before
// it spends money (X1). That only works if the notice arrives while there are
// working days left: a Friday-afternoon notice for a Monday run is one weekend
// and no time. Two BUSINESS days is the promise, so weekends have to be
// counted out, and the count has to happen in the tenant's own timezone —
// 6 a.m. Monday in Chicago is still Sunday in UTC.
//
// Mon–Fri only. No holiday table (SCOPE_GROWTH_GAPS §3E is explicit about
// that): a public holiday shifts the notice by a day at worst, and holiday
// calendars are per-country, per-state and endlessly wrong.

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The calendar date + weekday a moment falls on, in `timezone`. */
export function zonedDateParts(date, timezone = "America/Chicago") {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10),
    day: parseInt(p.day, 10),
    weekday: WEEKDAYS[p.weekday],
  };
}

function toDayNumber({ year, month, day }) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function isBusinessDay(dayNumber) {
  // 1970-01-01 (day 0) was a Thursday.
  const weekday = (dayNumber + 4) % 7; // 0 = Sunday
  return weekday >= 1 && weekday <= 5;
}

/**
 * Business days from `from` to `to`, counting the days AFTER from's local date
 * up to and including to's local date.
 *
 *   Friday 16:00 → Tuesday  = 2   (Sat/Sun don't count; Mon = 1, Tue = 2)
 *   Thursday     → Friday   = 1
 *   Friday       → Monday   = 1
 *   same day                = 0
 *   already past            = negative
 */
export function businessDaysUntil(from, to, timezone = "America/Chicago") {
  const a = toDayNumber(zonedDateParts(new Date(from), timezone));
  const b = toDayNumber(zonedDateParts(new Date(to), timezone));
  if (b === a) return 0;
  const sign = b > a ? 1 : -1;
  let count = 0;
  for (let d = a + sign; ; d += sign) {
    if (isBusinessDay(d)) count += sign;
    if (d === b) break;
  }
  return count;
}

/** True when `to` is in the future and no more than `days` business days away. */
export function isWithinBusinessDays(from, to, days = 2, timezone = "America/Chicago") {
  if (new Date(to).getTime() <= new Date(from).getTime()) return false;
  const n = businessDaysUntil(from, to, timezone);
  return n >= 0 && n <= days;
}

/** "Tue, Sep 9" — the run date as the customer's own calendar shows it. */
export function formatRunDate(date, timezone = "America/Chicago") {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric",
  }).format(new Date(date));
}
