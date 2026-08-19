/**
 * Do-not-disturb hours.
 *
 * The crossing-midnight case is the normal one for care work, and getting it
 * backwards would silence alerts all day and deliver them all night. That is
 * most of what these tests are for.
 */

import {
  describeQuietHours,
  isQuietNow,
  shouldPlaySound,
  type QuietHours,
} from '../lib/push/quiet-hours';

/** A Date at a given local hour and minute; the date itself is irrelevant. */
const at = (h: number, m = 0) => new Date(2026, 7, 18, h, m, 0);

const NIGHT: QuietHours = { start: '22:00', end: '07:00' };
const AFTERNOON: QuietHours = { start: '13:00', end: '14:00' };
const NONE: QuietHours = { start: null, end: null };

describe('isQuietNow — window crossing midnight', () => {
  test.each([
    [22, 0, true, 'right at the start'],
    [23, 30, true, 'before midnight'],
    [0, 15, true, 'just after midnight'],
    [6, 59, true, 'the last minute'],
    [7, 0, false, 'the end is exclusive'],
    [12, 0, false, 'midday'],
    [21, 59, false, 'a minute before it starts'],
  ])('%i:%i -> %s (%s)', (h, m, expected) => {
    expect(isQuietNow(NIGHT, at(h, m))).toBe(expected);
  });
});

describe('isQuietNow — same-day window', () => {
  test('inside the window is quiet', () => {
    expect(isQuietNow(AFTERNOON, at(13, 30))).toBe(true);
  });

  test('outside it is not', () => {
    expect(isQuietNow(AFTERNOON, at(9, 0))).toBe(false);
    expect(isQuietNow(AFTERNOON, at(20, 0))).toBe(false);
  });

  /** The inverse of the midnight case — must not silence the other 23 hours. */
  test('a narrow window does not leak into the rest of the day', () => {
    let quietCount = 0;
    for (let h = 0; h < 24; h += 1) if (isQuietNow(AFTERNOON, at(h))) quietCount += 1;
    expect(quietCount).toBe(1);
  });

  test('a night window silences roughly nine hours, not fifteen', () => {
    let quietCount = 0;
    for (let h = 0; h < 24; h += 1) if (isQuietNow(NIGHT, at(h))) quietCount += 1;
    expect(quietCount).toBe(9);
  });
});

describe('isQuietNow — nothing configured', () => {
  test('no quiet hours means never quiet', () => {
    expect(isQuietNow(NONE, at(3))).toBe(false);
  });

  test('a half-configured window is ignored rather than guessed at', () => {
    expect(isQuietNow({ start: '22:00', end: null }, at(23))).toBe(false);
    expect(isQuietNow({ start: null, end: '07:00' }, at(3))).toBe(false);
  });

  test('a zero-length window silences nothing', () => {
    expect(isQuietNow({ start: '22:00', end: '22:00' }, at(22))).toBe(false);
  });

  test('nonsense times are ignored, not treated as midnight', () => {
    expect(isQuietNow({ start: '99:99', end: '07:00' }, at(3))).toBe(false);
    expect(isQuietNow({ start: 'later', end: 'soon' }, at(3))).toBe(false);
  });
});

describe('shouldPlaySound', () => {
  test('routine alerts are silent during quiet hours', () => {
    expect(shouldPlaySound(NIGHT, 'routine', at(2))).toBe(false);
  });

  test('routine alerts make a sound outside them', () => {
    expect(shouldPlaySound(NIGHT, 'routine', at(10))).toBe(true);
  });

  /**
   * The rule that matters. Quiet hours suppress noise; they must never make a
   * carer unreachable when something is actually wrong.
   */
  test('urgent alerts always sound, at any hour', () => {
    for (const h of [0, 3, 6, 12, 23]) {
      expect(shouldPlaySound(NIGHT, 'urgent', at(h))).toBe(true);
    }
  });

  test('with no quiet hours set, everything sounds', () => {
    expect(shouldPlaySound(NONE, 'routine', at(3))).toBe(true);
  });
});

describe('describeQuietHours', () => {
  test('says plainly when nothing is set', () => {
    expect(describeQuietHours(NONE)).toMatch(/always/i);
  });

  /** A carer must know urgent alerts still get through, or they will not use it. */
  test('the description promises urgent alerts still arrive', () => {
    expect(describeQuietHours(NIGHT)).toMatch(/urgent/i);
    expect(describeQuietHours(NIGHT)).toContain('22:00');
    expect(describeQuietHours(NIGHT)).toContain('07:00');
  });
});
