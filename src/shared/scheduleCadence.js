// shared/scheduleCadence.js — ESM mirror of LUMEN-API's scheduleCadence.js.
//
// Two repos can't share a code module directly (arion-func is ESM, LUMEN-API
// is CJS), so this file deliberately mirrors the logic line-for-line. The
// API writes next_run_at; the timer recomputes next_run_at after dispatching;
// they MUST agree on cadence semantics or we'd see clock drift across runs.
//
// IF YOU CHANGE LOGIC HERE, change LUMEN-API/src/services/leadgen/scheduleCadence.js
// in the same commit.

export const CANONICAL_CADENCES = new Set(["daily", "weekly", "monthly", "custom"]);

export function isCadence(c) {
  return typeof c === "string" && CANONICAL_CADENCES.has(c);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function tzOffsetMinutes(utcDate, timezone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(utcDate).map(p => [p.type, p.value]));
  const asLocalUtcMs = Date.UTC(
    parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day),
    parseInt(parts.hour) === 24 ? 0 : parseInt(parts.hour),
    parseInt(parts.minute), parseInt(parts.second)
  );
  return (asLocalUtcMs - utcDate.getTime()) / 60000;
}

function zonedTimeToUtc(y, m, d, h, min, timezone) {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min, 0));
  const offset = tzOffsetMinutes(guess, timezone);
  return new Date(guess.getTime() - offset * 60000);
}

function utcToZonedParts(utcDate, timezone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    weekday: "short", hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(utcDate).map(x => [x.type, x.value]));
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(p.year),
    month: parseInt(p.month),
    day: parseInt(p.day),
    hour: parseInt(p.hour) === 24 ? 0 : parseInt(p.hour),
    minute: parseInt(p.minute),
    weekday: WEEKDAYS[p.weekday],
  };
}

function nextAtTime(from, tz, hour, minute) {
  const parts = utcToZonedParts(from, tz);
  let candidate = zonedTimeToUtc(parts.year, parts.month, parts.day, hour, minute, tz);
  let safety = 0;
  while (candidate.getTime() <= from.getTime() && safety++ < 5) {
    const next = utcToZonedParts(new Date(candidate.getTime() + 86400000), tz);
    candidate = zonedTimeToUtc(next.year, next.month, next.day, hour, minute, tz);
  }
  return candidate;
}

function nextWeeklyAt(from, tz, targetWeekday, hour, minute) {
  const parts = utcToZonedParts(from, tz);
  let daysAhead = (targetWeekday - parts.weekday + 7) % 7;
  let candidate = zonedTimeToUtc(parts.year, parts.month, parts.day + daysAhead, hour, minute, tz);
  if (candidate.getTime() <= from.getTime()) {
    daysAhead += 7;
    candidate = zonedTimeToUtc(parts.year, parts.month, parts.day + daysAhead, hour, minute, tz);
  }
  return candidate;
}

function nextMonthlyAt(from, tz, dayOfMonth, hour, minute) {
  const parts = utcToZonedParts(from, tz);
  let candidate = zonedTimeToUtc(parts.year, parts.month, dayOfMonth, hour, minute, tz);
  if (candidate.getTime() <= from.getTime()) {
    const ny = parts.month === 12 ? parts.year + 1 : parts.year;
    const nm = parts.month === 12 ? 1 : parts.month + 1;
    candidate = zonedTimeToUtc(ny, nm, dayOfMonth, hour, minute, tz);
  }
  return candidate;
}

function parseField(spec, min, max) {
  if (spec === "*") {
    const out = new Set();
    for (let i = min; i <= max; i++) out.add(i);
    return out;
  }
  const out = new Set();
  for (const part of spec.split(",")) {
    let step = 1;
    let rangeSpec = part;
    if (part.includes("/")) {
      const [r, s] = part.split("/");
      rangeSpec = r;
      step = parseInt(s);
      if (!Number.isFinite(step) || step <= 0) throw new Error(`Bad cron step: ${part}`);
    }
    let lo = min, hi = max;
    if (rangeSpec === "*") { lo = min; hi = max; }
    else if (rangeSpec.includes("-")) {
      const [a, b] = rangeSpec.split("-").map(Number);
      lo = a; hi = b;
    } else {
      const n = parseInt(rangeSpec);
      if (!Number.isFinite(n)) throw new Error(`Bad cron value: ${part}`);
      lo = n; hi = n;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron field out of range: ${part}`);
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron must have 5 fields: "${expr}"`);
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4], 0, 6),
  };
}

function nextFromCron(expr, from, tz) {
  const cron = parseCron(expr);
  const startUtcMs = from.getTime() + 60000 - (from.getTime() % 60000);
  const MAX_ITERS = 366 * 24 * 60;
  for (let i = 0; i < MAX_ITERS; i++) {
    const candidate = new Date(startUtcMs + i * 60000);
    const p = utcToZonedParts(candidate, tz);
    if (!cron.minute.has(p.minute)) continue;
    if (!cron.hour.has(p.hour)) continue;
    if (!cron.month.has(p.month)) continue;
    const domRestricted = cron.dayOfMonth.size < 31;
    const dowRestricted = cron.dayOfWeek.size < 7;
    const domMatch = cron.dayOfMonth.has(p.day);
    const dowMatch = cron.dayOfWeek.has(p.weekday);
    if (domRestricted && dowRestricted) {
      if (!domMatch && !dowMatch) continue;
    } else if (domRestricted) {
      if (!domMatch) continue;
    } else if (dowRestricted) {
      if (!dowMatch) continue;
    }
    return candidate;
  }
  throw new Error(`Cron expression "${expr}" has no fire time within 1 year`);
}

export function computeNextRun({ cadence, config, timezone, from }) {
  if (!isCadence(cadence)) throw new Error(`Invalid cadence: ${cadence}`);
  const base = from instanceof Date ? from : new Date();
  const tz = timezone || "America/Chicago";

  if (cadence === "custom") {
    const expr = typeof config === "string" ? config : config?.cron_expression;
    if (!expr) throw new Error("custom cadence requires a cron_expression");
    return nextFromCron(expr, base, tz);
  }

  const hour = clampInt(config?.hour, 0, 23, 6);
  const minute = clampInt(config?.minute, 0, 59, 0);

  if (cadence === "daily") return nextAtTime(base, tz, hour, minute);
  if (cadence === "weekly") {
    const weekday = clampInt(config?.weekday, 0, 6, 1);
    return nextWeeklyAt(base, tz, weekday, hour, minute);
  }
  if (cadence === "monthly") {
    const dom = clampInt(config?.day_of_month, 1, 28, 1);
    return nextMonthlyAt(base, tz, dom, hour, minute);
  }
  throw new Error(`Unreachable cadence: ${cadence}`);
}
