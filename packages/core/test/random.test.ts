import { describe, expect, it } from 'vitest';
import { randomFromRegex, regexError, REPEAT_CAP } from '../src';

describe('random from regex', () => {
  const patterns = [
    'CASE-[A-Z]{3}\\d{4}',
    '[a-z0-9_]{5,10}',
    '[^a-z]{6}',
    '(foo|bar|baz)-\\w+',
    '(?:ab)*c?',
    '(?<id>[0-9]{2})x\\1',
    '\\.\\*\\[literal\\]',
    'a{2,}b+',
    '^\\d{3}\\s\\D\\S\\W$',
    '[\\d.-]{4}',
    '{x}',
    '\\x41\\u0042',
  ];

  it.each(patterns)('draws strings matching %s', (pattern) => {
    const re = new RegExp(`^(?:${pattern})$`);
    for (let i = 0; i < 200; i++) expect(randomFromRegex(pattern)).toMatch(re);
  });

  it('draws different values', () => {
    const values = new Set(Array.from({ length: 20 }, () => randomFromRegex('[A-Z]{8}')));
    expect(values.size).toBeGreaterThan(15);
  });

  it('is deterministic for a fixed random source and caps unbounded repeats', () => {
    expect(randomFromRegex('[A-Z]{3}x*', () => 0)).toBe('AAA');
    expect(randomFromRegex('x*', () => 0.9999)).toBe('x'.repeat(REPEAT_CAP));
  });

  it('reports invalid and unsupported syntax', () => {
    expect(regexError('[A-Z]{3}')).toBeUndefined();
    for (const bad of ['(abc', 'abc)', '[abc', '*a', 'a**', '(?=a)', '\\1(a)', '[z-a]', 'a{3,1}', '\\q', '\\']) {
      expect(regexError(bad), bad).toBeTruthy();
      expect(() => randomFromRegex(bad)).toThrow();
    }
  });
});
