/**
 * Availability, absence and mileage.
 *
 * These rules exist to stop a carer submitting something the office has to
 * ring them about, and to get the money right — a payroll figure that is a
 * penny out generates a phone call and erodes trust in the whole app.
 */

import {
  ABSENCE_REASONS,
  DAYS,
  HMRC_RATE_ABOVE_10K,
  HMRC_RATE_FIRST_10K,
  MAX_CLAIM_MILES,
  NOTICE_DAYS,
  absenceDays,
  findClash,
  formatClaim,
  mileageAmount,
  summariseAvailability,
  validateAbsence,
  validateMileage,
  validateWindow,
  windowsOverlap,
  type AvailabilityWindow,
} from '../lib/hr/availability';

function win(over: Partial<AvailabilityWindow> = {}): AvailabilityWindow {
  return { id: 'w1', day: 'monday', start: '07:00', end: '14:00', ...over };
}

describe('validateWindow', () => {
  test('a normal shift passes', () => {
    expect(validateWindow('07:00', '14:00').valid).toBe(true);
  });

  test('malformed times are rejected with a format hint', () => {
    expect(validateWindow('7am', '2pm').error).toMatch(/HH:MM/);
    expect(validateWindow('25:00', '26:00').valid).toBe(false);
  });

  test('a zero-length window is rejected', () => {
    expect(validateWindow('09:00', '09:00').valid).toBe(false);
  });

  /**
   * Night staff genuinely work 22:00–07:00, but one row spanning midnight
   * breaks every "who is free on Tuesday" query. The error explains the fix
   * rather than just refusing.
   */
  test('an overnight window is refused with instructions, not a bare error', () => {
    const v = validateWindow('22:00', '07:00');
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/two windows/i);
  });
});

describe('windowsOverlap', () => {
  test('same day, overlapping hours', () => {
    expect(windowsOverlap(win(), win({ id: 'w2', start: '13:00', end: '18:00' }))).toBe(true);
  });

  test('different days never clash', () => {
    expect(windowsOverlap(win(), win({ id: 'w2', day: 'tuesday' }))).toBe(false);
  });

  /** Finishing at 14:00 and starting at 14:00 is a back-to-back shift. */
  test('touching ends do not count as an overlap', () => {
    expect(windowsOverlap(win(), win({ id: 'w2', start: '14:00', end: '20:00' }))).toBe(false);
  });

  test('one window fully inside another', () => {
    expect(windowsOverlap(win(), win({ id: 'w2', start: '09:00', end: '11:00' }))).toBe(true);
  });
});

describe('findClash', () => {
  test('returns the clashing window so the carer can be shown it', () => {
    const existing = [win({ id: 'a' })];
    const clash = findClash(existing, win({ id: 'b', start: '10:00', end: '16:00' }));
    expect(clash?.id).toBe('a');
  });

  test('a window does not clash with itself when edited', () => {
    const existing = [win({ id: 'a' })];
    expect(findClash(existing, win({ id: 'a', start: '08:00', end: '15:00' }))).toBeNull();
  });

  test('no clash returns null', () => {
    expect(findClash([win()], win({ id: 'b', day: 'friday' }))).toBeNull();
  });
});

describe('summariseAvailability', () => {
  test('says plainly when nothing is set', () => {
    expect(summariseAvailability([])).toBe('No availability set');
  });

  test('counts distinct days, not windows', () => {
    const windows = [
      win({ id: 'a', day: 'monday', start: '07:00', end: '12:00' }),
      win({ id: 'b', day: 'monday', start: '14:00', end: '18:00' }),
    ];
    expect(summariseAvailability(windows)).toContain('1 day');
  });

  test('every day is a valid key', () => {
    expect(DAYS).toHaveLength(7);
  });
});

describe('validateAbsence', () => {
  const now = new Date(2026, 7, 1);
  const day = (d: number) => new Date(2026, 7, d);

  test('a well-planned holiday passes with no warning', () => {
    const v = validateAbsence('holiday', day(25), day(29), now);
    expect(v.valid).toBe(true);
    expect(v.warning).toBeNull();
  });

  test('an end date before the start is refused', () => {
    const v = validateAbsence('holiday', day(20), day(10), now);
    expect(v.valid).toBe(false);
  });

  /**
   * Short notice WARNS, never blocks. An app that refused would simply be
   * bypassed with a phone call, losing the record entirely.
   */
  test('short-notice holiday is allowed but flagged', () => {
    const v = validateAbsence('holiday', day(3), day(5), now);
    expect(v.valid).toBe(true);
    expect(v.warning).toMatch(new RegExp(String(NOTICE_DAYS)));
  });

  test('sickness never asks for notice', () => {
    expect(validateAbsence('sickness', day(1), day(2), now).warning).toBeNull();
  });

  test('bereavement never asks for notice either', () => {
    expect(validateAbsence('bereavement', day(1), day(3), now).warning).toBeNull();
  });

  test('every reason has a label and a notice rule', () => {
    for (const r of ABSENCE_REASONS) {
      expect(r.label).toBeTruthy();
      expect(typeof r.needsNotice).toBe('boolean');
    }
  });
});

describe('absenceDays', () => {
  test('a single day is one, not zero', () => {
    expect(absenceDays(new Date(2026, 7, 10), new Date(2026, 7, 10))).toBe(1);
  });

  test('inclusive of both ends', () => {
    expect(absenceDays(new Date(2026, 7, 10), new Date(2026, 7, 14))).toBe(5);
  });

  test('spans a month boundary', () => {
    expect(absenceDays(new Date(2026, 7, 30), new Date(2026, 8, 2))).toBe(4);
  });
});

describe('mileageAmount — HMRC rates', () => {
  test('the standard rate is 45p', () => {
    expect(HMRC_RATE_FIRST_10K).toBe(0.45);
    expect(mileageAmount(10)).toBe(4.5);
  });

  test('a fractional journey rounds to whole pence', () => {
    expect(mileageAmount(12.5)).toBe(5.63);
  });

  test('the rate drops to 25p above 10,000 miles', () => {
    expect(HMRC_RATE_ABOVE_10K).toBe(0.25);
    expect(mileageAmount(10, 10_000)).toBe(2.5);
  });

  /** A claim straddling the threshold must be split, not charged wholesale. */
  test('a claim crossing the threshold is split across both rates', () => {
    // 5 miles at 45p (to reach 10,000) + 5 at 25p
    expect(mileageAmount(10, 9_995)).toBe(3.5);
  });

  test('zero and negative claims are worth nothing', () => {
    expect(mileageAmount(0)).toBe(0);
    expect(mileageAmount(-5)).toBe(0);
  });

  /** Floating-point pounds are how a carer ends up 1p short and rings in. */
  test('results are always whole pence', () => {
    for (const m of [0.1, 3.33, 7.77, 99.99]) {
      const amount = mileageAmount(m);
      expect(Math.round(amount * 100)).toBe(amount * 100);
    }
  });
});

describe('validateMileage', () => {
  test('a normal journey passes', () => {
    expect(validateMileage(12.5).valid).toBe(true);
  });

  test('zero or missing is refused', () => {
    expect(validateMileage(0).valid).toBe(false);
    expect(validateMileage(Number.NaN).valid).toBe(false);
  });

  test('an implausible distance is caught as a likely typo', () => {
    const v = validateMileage(MAX_CLAIM_MILES + 1);
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/check the number/i);
  });
});

describe('formatClaim', () => {
  test('reads as miles and money', () => {
    expect(formatClaim(12.5)).toBe('12.5 miles · £5.63');
  });

  test('one mile is singular', () => {
    expect(formatClaim(1)).toBe('1 mile · £0.45');
  });

  test('always two decimal places', () => {
    expect(formatClaim(10)).toContain('£4.50');
  });
});
