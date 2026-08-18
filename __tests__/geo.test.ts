/**
 * Location rules.
 *
 * These decide whether a carer can start their visit, so each test names the
 * real doorstep situation it protects. The governing rule throughout: capture
 * the truth, never block the carer.
 */

import {
  AT_ADDRESS_RADIUS_M,
  AWAY_REASONS,
  assessLocation,
  distanceMetres,
  formatDistance,
  needsReason,
  verdictMessage,
} from '../lib/location/geo';

// Two real Manchester points ~1.2km apart.
const CLIENT = { lat: 53.4934, lng: -2.2361 };
const NEARBY = { lat: 53.4936, lng: -2.2359, accuracy: 12 };

describe('distanceMetres', () => {
  test('the same point is zero', () => {
    expect(distanceMetres(CLIENT, CLIENT)).toBe(0);
  });

  test('a few doors away is tens of metres', () => {
    const d = distanceMetres(CLIENT, NEARBY);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(50);
  });

  test('a known separation comes out right', () => {
    // 0.01 degrees of latitude is ~1113m anywhere on earth.
    const d = distanceMetres({ lat: 53.0, lng: -2.0 }, { lat: 53.01, lng: -2.0 });
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });

  /**
   * At UK latitudes a degree of longitude is only ~62% of a degree of
   * latitude. A naive Pythagorean shortcut would report these as equal.
   */
  test('longitude is correctly compressed at UK latitudes', () => {
    const northSouth = distanceMetres({ lat: 53.0, lng: -2.0 }, { lat: 53.01, lng: -2.0 });
    const eastWest = distanceMetres({ lat: 53.0, lng: -2.0 }, { lat: 53.0, lng: -1.99 });
    expect(eastWest).toBeLessThan(northSouth * 0.7);
  });

  test('distance is symmetric', () => {
    expect(distanceMetres(CLIENT, NEARBY)).toBe(distanceMetres(NEARBY, CLIENT));
  });
});

describe('assessLocation', () => {
  test('standing at the door is unremarkable', () => {
    const v = assessLocation(NEARBY, CLIENT);
    expect(v.kind).toBe('at_address');
    expect(needsReason(v)).toBe(false);
  });

  test('just inside the radius still counts as at the address', () => {
    // ~100m north.
    const v = assessLocation({ lat: CLIENT.lat + 0.0009, lng: CLIENT.lng, accuracy: 10 }, CLIENT);
    expect(v.kind).toBe('at_address');
  });

  test('a street away asks for a reason but is never blocked', () => {
    const v = assessLocation({ lat: CLIENT.lat + 0.005, lng: CLIENT.lng, accuracy: 10 }, CLIENT);
    expect(v.kind).toBe('away');
    expect(needsReason(v)).toBe(true);
  });

  /**
   * THE case that matters most. A fix claiming 300m with a 600m error radius
   * is not evidence of anything; quoting the number would be a confident lie.
   */
  test('a vague fix is called unreliable rather than quoted as a distance', () => {
    const v = assessLocation({ lat: CLIENT.lat + 0.003, lng: CLIENT.lng, accuracy: 600 }, CLIENT);
    expect(v.kind).toBe('unreliable');
    expect(verdictMessage(v)).not.toMatch(/\d+m from/);
  });

  test('accuracy is judged before distance, even when close', () => {
    // Would be "at_address" on distance alone, but the fix is meaningless.
    const v = assessLocation({ ...NEARBY, accuracy: 900 }, CLIENT);
    expect(v.kind).toBe('unreliable');
  });

  test('no fix at all still lets the carer proceed', () => {
    const v = assessLocation(null, CLIENT, 'timeout');
    expect(v.kind).toBe('no_fix');
    expect(needsReason(v)).toBe(true);
  });

  test('permission denied is distinguished from a timeout', () => {
    const denied = assessLocation(null, CLIENT, 'denied');
    expect(denied.kind === 'no_fix' && denied.reason).toBe('denied');
    expect(verdictMessage(denied)).toMatch(/still check in/i);
  });

  test('a client with no address on file is handled, not crashed on', () => {
    expect(assessLocation(NEARBY, { lat: null, lng: null }).kind).toBe('no_client_location');
    expect(assessLocation(NEARBY, null).kind).toBe('no_client_location');
  });

  test('a missing accuracy reading is tolerated', () => {
    const v = assessLocation({ lat: CLIENT.lat, lng: CLIENT.lng }, CLIENT);
    expect(v.kind).toBe('at_address');
  });

  /** No verdict may ever prevent a check-in. */
  test('every possible verdict still allows the carer to work', () => {
    const verdicts = [
      assessLocation(NEARBY, CLIENT),
      assessLocation({ lat: CLIENT.lat + 0.05, lng: CLIENT.lng, accuracy: 10 }, CLIENT),
      assessLocation({ ...NEARBY, accuracy: 900 }, CLIENT),
      assessLocation(null, CLIENT, 'denied'),
      assessLocation(NEARBY, null),
    ];
    for (const v of verdicts) {
      expect(verdictMessage(v)).toBeTruthy();
      expect(typeof needsReason(v)).toBe('boolean');
    }
  });
});

describe('verdictMessage', () => {
  test('very close reads as a statement, not a measurement', () => {
    // ~8m away — on the doorstep. NEARBY is 26m, which deliberately still
    // shows the number: 25m is the line between "you are here" and a figure
    // worth reporting.
    const doorstep = { lat: CLIENT.lat + 0.00007, lng: CLIENT.lng, accuracy: 6 };
    expect(verdictMessage(assessLocation(doorstep, CLIENT))).toBe('At the address');
  });

  test('mid-range inside the radius still shows the number', () => {
    const v = assessLocation({ lat: CLIENT.lat + 0.0009, lng: CLIENT.lng, accuracy: 8 }, CLIENT);
    expect(verdictMessage(v)).toMatch(/^\d+m from the address$/);
  });

  /** Nothing here should read as an accusation. */
  test('no message blames the carer', () => {
    const messages = [
      verdictMessage(assessLocation({ lat: CLIENT.lat + 0.05, lng: CLIENT.lng, accuracy: 10 }, CLIENT)),
      verdictMessage(assessLocation(null, CLIENT, 'denied')),
      verdictMessage(assessLocation({ ...NEARBY, accuracy: 900 }, CLIENT)),
    ];
    for (const m of messages) {
      expect(m).not.toMatch(/error|invalid|fail|wrong location|cannot/i);
    }
  });
});

describe('formatDistance', () => {
  test('metres under a kilometre', () => {
    expect(formatDistance(0)).toBe('0m');
    expect(formatDistance(150)).toBe('150m');
    expect(formatDistance(999)).toBe('999m');
  });

  test('kilometres above, to one decimal', () => {
    expect(formatDistance(1000)).toBe('1.0km');
    expect(formatDistance(2350)).toBe('2.4km');
  });
});

describe('away reasons', () => {
  test('the list is short enough to pick from on a doorstep', () => {
    expect(AWAY_REASONS.length).toBeLessThanOrEqual(5);
  });

  test('there is always an escape hatch', () => {
    expect(AWAY_REASONS.some((r) => r.code === 'other')).toBe(true);
  });

  /** Most of these are the office's fault, and the wording should say so. */
  test('reasons do not imply the carer did something wrong', () => {
    for (const r of AWAY_REASONS) {
      expect(r.label).not.toMatch(/failed|forgot|incorrect|error/i);
    }
  });

  test('the radius is generous enough for a terraced street', () => {
    expect(AT_ADDRESS_RADIUS_M).toBeGreaterThanOrEqual(100);
  });
});
