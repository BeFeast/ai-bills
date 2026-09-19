import { describe, expect, test } from 'vitest';
import { barWidth, countdown, duration, normalizePct, pickPct, refillLabel } from '../src/components/format';

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

describe('durations', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  test('shows days past 24 hours and drops zero hours under one hour', () => {
    expect(duration(27 * 3_600_000 + 14 * 60_000)).toBe('1d 3h 14m');
    expect(duration(5 * 60_000)).toBe('5m');
    expect(duration(2 * 3_600_000)).toBe('2h 0m');
    expect(countdown('2026-09-20T15:14:00Z', now)).toBe('1d 3h 14m left');
    expect(countdown('2026-09-19T11:55:00Z', now)).toBe('5m ago');
  });
  test('names the refill and its timing', () => {
    expect(refillLabel('2026-09-22T16:00:00Z', now)).toBe('refills in 3d 4h 0m');
    expect(refillLabel('2026-09-19T11:00:00Z', now)).toBe('refill was due 1h 0m ago');
    expect(refillLabel(null, now)).toBeNull();
  });
});
