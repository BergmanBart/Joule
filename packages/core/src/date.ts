/**
 * Dates from an expression: `today`, `now`, either followed by offsets such as `+ 5wd` or `- 1m`,
 * or an absolute date (`2026-12-25`, `25-12-2026 14:30`). The same rules are implemented in
 * Python for the generated Robot files (JouleLib.py); keep the grammar, units and format tokens in sync.
 */

export const DEFAULT_DATE_FORMAT = 'dd-MM-yyyy';

type Unit = 'd' | 'wd' | 'w' | 'm' | 'y' | 'h' | 'min';

const UNITS: Record<string, Unit> = {
  d: 'd', day: 'd', days: 'd',
  wd: 'wd', workday: 'wd', workdays: 'wd',
  w: 'w', week: 'w', weeks: 'w',
  m: 'm', month: 'm', months: 'm',
  y: 'y', year: 'y', years: 'y',
  h: 'h', hour: 'h', hours: 'h',
  min: 'min', minute: 'min', minutes: 'min',
};

const RELATIVE = /^(today|now)(.*)$/;
const OFFSET = /^\s*([+-])\s*([0-9]+)\s*([a-z]+)/;
const ISO = /^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})(?:\s+([0-9]{1,2}):([0-9]{2}))?$/;
const DMY = /^([0-9]{1,2})[-/.]([0-9]{1,2})[-/.]([0-9]{4})(?:\s+([0-9]{1,2}):([0-9]{2}))?$/;
const TOKENS = /yyyy|yy|MM|M|dd|d|HH|H|mm|ss/g;

/** Local date and time; `month` is 0-based and years below 100 are kept as they are. */
function at(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0): Date {
  const d = new Date(2000, 0, 1, hours, minutes, seconds);
  d.setFullYear(year, month, day);
  return d;
}

const daysIn = (year: number, month: number) => at(year, month + 1, 0).getDate();

/** Months (or 12 × years) later; the day is clamped to the end of a shorter month. */
function addMonths(d: Date, n: number): Date {
  const total = d.getFullYear() * 12 + d.getMonth() + n;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  return at(year, month, Math.min(d.getDate(), daysIn(year, month)), d.getHours(), d.getMinutes(), d.getSeconds());
}

function addWorkdays(d: Date, n: number): Date {
  const r = new Date(d);
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) {
    r.setDate(r.getDate() + step);
    if (r.getDay() !== 0 && r.getDay() !== 6) left--;
  }
  return r;
}

function shift(d: Date, n: number, unit: Unit): Date {
  const r = new Date(d);
  switch (unit) {
    case 'd':
      r.setDate(r.getDate() + n);
      return r;
    case 'w':
      r.setDate(r.getDate() + 7 * n);
      return r;
    case 'wd':
      return addWorkdays(d, n);
    case 'm':
      return addMonths(d, n);
    case 'y':
      return addMonths(d, 12 * n);
    case 'h':
      r.setHours(r.getHours() + n);
      return r;
    case 'min':
      r.setMinutes(r.getMinutes() + n);
      return r;
  }
}

function absolute(s: string): Date {
  const iso = ISO.exec(s);
  const m = iso ?? DMY.exec(s);
  if (!m) throw new Error('Expected today, now or a date such as 2026-12-25');
  const [year, month, day] = (iso ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]]).map(Number);
  const [hours, minutes] = [Number(m[4] ?? 0), Number(m[5] ?? 0)];
  if (month < 1 || month > 12) throw new Error(`Month ${month} does not exist`);
  if (day < 1 || day > daysIn(year, month - 1)) throw new Error(`Day ${day} does not exist in ${year}-${pad(month)}`);
  if (hours > 23 || minutes > 59) throw new Error(`Time ${m[4]}:${m[5]} does not exist`);
  return at(year, month - 1, day, hours, minutes);
}

function evaluate(expression: string, now: Date): Date {
  const s = expression.trim().toLowerCase();
  if (!s) throw new Error('Empty date');
  const rel = RELATIVE.exec(s);
  if (!rel) return absolute(s);
  let d = new Date(now);
  d.setMilliseconds(0);
  if (rel[1] === 'today') d.setHours(0, 0, 0, 0);
  let rest = rel[2];
  while (rest.trim()) {
    const m = OFFSET.exec(rest);
    if (!m) throw new Error(`Expected an offset such as "+ 3d" at "${rest.trim()}"`);
    const unit = UNITS[m[3]];
    if (!unit) throw new Error(`Unknown unit "${m[3]}"`);
    d = shift(d, (m[1] === '-' ? -1 : 1) * Number(m[2]), unit);
    rest = rest.slice(m[0].length);
  }
  return d;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

export function formatDate(d: Date, format: string = DEFAULT_DATE_FORMAT): string {
  return (format || DEFAULT_DATE_FORMAT).replace(TOKENS, (t) => {
    switch (t) {
      case 'yyyy':
        return pad(d.getFullYear(), 4);
      case 'yy':
        return pad(d.getFullYear() % 100);
      case 'MM':
        return pad(d.getMonth() + 1);
      case 'M':
        return String(d.getMonth() + 1);
      case 'dd':
        return pad(d.getDate());
      case 'd':
        return String(d.getDate());
      case 'HH':
        return pad(d.getHours());
      case 'H':
        return String(d.getHours());
      case 'mm':
        return pad(d.getMinutes());
      default:
        return pad(d.getSeconds());
    }
  });
}

/** The date `expression` stands for, formatted; throws when the expression is not valid. */
export function dateFromExpression(expression: string, format: string = DEFAULT_DATE_FORMAT, now: Date = new Date()): string {
  return formatDate(evaluate(expression, now), format);
}

/** Why `expression` is not a valid date, or undefined when it is. */
export function dateError(expression: string): string | undefined {
  try {
    evaluate(expression, new Date());
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
