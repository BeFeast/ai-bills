import { describe, expect, test } from 'vitest';
import { barWidth, normalizePct, pickPct } from '../src/components/format';

describe('percent formatting', () => {
  test('normalizePct takes Claude percents as-is', () => {
    expect(normalizePct(42)).toBe(42);
    expect(normalizePct(0)).toBe(0);
    expect(normalizePct(100)).toBe(100);
    expect(normalizePct(30.067)).toBe(30.067);
  });

  test('regression: 1% is 1%, not a rescaled 100%', () => {
    // claude-work weekly_all on 2026-07-27 read 1 %; the old fraction heuristic
    // rendered it as a full red 100 % bar.
    expect(normalizePct(1)).toBe(1);
    expect(normalizePct(0.42)).toBe(0.42);
    expect(pickPct(undefined, 1)).toBe(1);
    expect(barWidth(normalizePct(1))).toBe('1%');
  });

  test('normalizePct rejects non-finite input', () => {
    expect(normalizePct(null)).toBeNull();
    expect(normalizePct('12')).toBeNull();
    expect(normalizePct(Number.NaN)).toBeNull();
  });

  test('pickPct returns the first usable value', () => {
    expect(pickPct(null, undefined, 7, 9)).toBe(7);
    expect(pickPct(0, 9)).toBe(0);
    expect(pickPct(null, undefined)).toBeNull();
  });
});
