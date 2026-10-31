import { describe, expect, it } from 'vitest';
import { dateError, dateFromExpression } from '../src';

// Friday 30 January 2026, 14:05:09
const NOW = new Date(2026, 0, 30, 14, 5, 9);
const date = (expression: string, format?: string, now = NOW) => dateFromExpression(expression, format, now);

describe('date expressions', () => {
  it.each([
    ['today', '30-01-2026'],
    ['  Today ', '30-01-2026'],
    ['today + 3d', '02-02-2026'],
    ['today-1w', '23-01-2026'],
    ['today + 2 days - 1 week', '25-01-2026'],
    ['today + 1m', '28-02-2026'],
    ['today + 1 month + 1d', '01-03-2026'],
    ['TODAY + 1Y', '30-01-2027'],
    ['today - 13m', '30-12-2024'],
    ['today + 1wd', '02-02-2026'],
    ['today - 5wd', '23-01-2026'],
    ['today + 6 workdays', '09-02-2026'],
    ['today + 0wd', '30-01-2026'],
  ])('%s → %s', (expression, expected) => {
    expect(date(expression)).toBe(expected);
  });

  it('keeps the time for now and drops it for today', () => {
    expect(date('now', 'yyyy-MM-dd HH:mm:ss')).toBe('2026-01-30 14:05:09');
    expect(date('today', 'yyyy-MM-dd HH:mm:ss')).toBe('2026-01-30 00:00:00');
    expect(date('now + 2h - 30min', 'HH:mm')).toBe('15:35');
    expect(date('now + 10 hours', 'd-M-yy H:mm')).toBe('31-1-26 0:05');
  });

  it('skips weekends for working days from a weekend day', () => {
    const saturday = new Date(2026, 0, 31, 9, 0);
    expect(date('today + 1wd', undefined, saturday)).toBe('02-02-2026');
    expect(date('today - 1wd', undefined, saturday)).toBe('30-01-2026');
  });

  it('clamps to the end of a shorter month', () => {
    expect(date('today + 1y', undefined, new Date(2028, 1, 29))).toBe('28-02-2029');
    expect(date('today + 1m', undefined, new Date(2026, 2, 31))).toBe('30-04-2026');
  });

  it('reads absolute dates in both orders', () => {
    expect(date('2026-12-25')).toBe('25-12-2026');
    expect(date('25/12/2026 14:30', 'yyyy-MM-dd HH:mm')).toBe('2026-12-25 14:30');
    expect(date('2028.2.29', 'yyyy-MM-dd')).toBe('2028-02-29');
  });

  it('formats with tokens and keeps other characters', () => {
    expect(date('today', 'dd.MM.yyyy')).toBe('30.01.2026');
    expect(date('today', 'yyyyMMdd')).toBe('20260130');
    expect(date('today', '')).toBe('30-01-2026');
  });

  it.each([
    ['', 'Empty date'],
    ['tomorrow', 'Expected today, now or a date'],
    ['today + 3x', 'Unknown unit "x"'],
    ['today +', 'Expected an offset'],
    ['today 3d', 'Expected an offset'],
    ['2026-13-01', 'Month 13 does not exist'],
    ['2026-02-30', 'Day 30 does not exist'],
    ['2026-12-25 24:00', 'Time 24:00 does not exist'],
    ['2026-12-25 + 1d', 'Expected today, now or a date'],
  ])('rejects %j', (expression, message) => {
    expect(dateError(expression)).toContain(message);
    expect(() => date(expression)).toThrow(message);
  });

  it('accepts valid expressions', () => {
    expect(dateError('now - 30min')).toBeUndefined();
    expect(dateError('25-12-2026')).toBeUndefined();
  });
});
