/**
 * Expiry banding — the rules that decide whether a carer is legally allowed
 * to work tomorrow. Every threshold in the Phase 3 brief is pinned here.
 */

import {
  bandPresentation,
  daysUntil,
  expiryBand,
  expiryPhrase,
  needsAttention,
  severityRank,
  worstBand,
} from '../lib/hr/expiry';

/** Fixed "today" so the suite can't drift with the wall clock. */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const inDays = (n: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('daysUntil', () => {
  test('counts whole days ahead', () => {
    expect(daysUntil(inDays(10), NOW)).toBe(10);
  });

  test('is negative once past', () => {
    expect(daysUntil(inDays(-3), NOW)).toBe(-3);
  });

  test('today is zero', () => {
    expect(daysUntil(inDays(0), NOW)).toBe(0);
  });

  test('null date returns null rather than throwing', () => {
    expect(daysUntil(null, NOW)).toBeNull();
  });

  test('an unparseable date returns null', () => {
    expect(daysUntil('not-a-date', NOW)).toBeNull();
  });

  /**
   * Both sides are floored to midnight, so the answer can't depend on what
   * time of day the check runs — otherwise a 7-day alert could fire a day
   * early or late depending on the hour of the cron run.
   */
  test('time of day does not shift the count', () => {
    const early = new Date('2026-06-15T00:01:00.000Z');
    const late = new Date('2026-06-15T23:59:00.000Z');
    expect(daysUntil('2026-06-22', early)).toBe(daysUntil('2026-06-22', late));
  });
});

describe('expiryBand', () => {
  test.each([
    [365, 'valid'],
    [61, 'valid'],
    [60, 'expiring_60'],
    [31, 'expiring_60'],
    [30, 'expiring_30'],
    [8, 'expiring_30'],
    [7, 'expiring_7'],
    [1, 'expiring_7'],
    [0, 'expiring_7'],
    [-1, 'expired'],
    [-400, 'expired'],
  ])('%i days out is %s', (days, expected) => {
    expect(expiryBand(inDays(days), NOW)).toBe(expected);
  });

  /**
   * The single most important case. A carer with no DBS on file is NOT
   * compliant, and showing a green tick for "no record" would defeat the
   * whole point of tracking it.
   */
  test('a missing date is "missing", never "valid"', () => {
    expect(expiryBand(null, NOW)).toBe('missing');
    expect(expiryBand(null, NOW)).not.toBe('valid');
  });

  test('expiring today still blocks — it is not yet expired but is urgent', () => {
    expect(expiryBand(inDays(0), NOW)).toBe('expiring_7');
  });
});

describe('severityRank / needsAttention', () => {
  test('expired outranks everything', () => {
    expect(severityRank('expired')).toBeGreaterThan(severityRank('missing'));
    expect(severityRank('expired')).toBeGreaterThan(severityRank('expiring_7'));
  });

  test('missing outranks any future expiry', () => {
    expect(severityRank('missing')).toBeGreaterThan(severityRank('expiring_7'));
  });

  test('only valid needs no attention', () => {
    expect(needsAttention('valid')).toBe(false);
    for (const b of ['expiring_60', 'expiring_30', 'expiring_7', 'expired', 'missing'] as const) {
      expect(needsAttention(b)).toBe(true);
    }
  });
});

describe('worstBand', () => {
  test('picks the most urgent of a set', () => {
    expect(worstBand(['valid', 'expiring_30', 'expired'])).toBe('expired');
    expect(worstBand(['valid', 'expiring_60'])).toBe('expiring_60');
  });

  test('all valid stays valid', () => {
    expect(worstBand(['valid', 'valid'])).toBe('valid');
  });

  /** No records at all means nothing has been checked — not "all good". */
  test('an empty set is missing, not valid', () => {
    expect(worstBand([])).toBe('missing');
  });
});

describe('expiryPhrase', () => {
  test.each([
    [5, 'Expires in 5 days'],
    [1, 'Expires in 1 day'],
    [0, 'Expires today'],
    [-1, 'Expired 1 day ago'],
    [-12, 'Expired 12 days ago'],
  ])('%i days out reads "%s"', (days, expected) => {
    expect(expiryPhrase(inDays(days), NOW)).toBe(expected);
  });

  test('no date is stated plainly', () => {
    expect(expiryPhrase(null, NOW)).toBe('No expiry recorded');
  });
});

describe('bandPresentation', () => {
  test('every band has styling — no undefined class strings in the UI', () => {
    for (const b of ['valid', 'expiring_60', 'expiring_30', 'expiring_7', 'expired', 'missing'] as const) {
      const p = bandPresentation(b);
      expect(p.label).toBeTruthy();
      expect(p.pill).toContain('bg-');
      expect(p.dot).toContain('bg-');
    }
  });

  test('expired is red and valid is not', () => {
    expect(bandPresentation('expired').pill).toContain('red');
    expect(bandPresentation('valid').pill).not.toContain('red');
  });
});
