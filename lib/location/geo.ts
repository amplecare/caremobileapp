/**
 * Location maths and check-in rules.
 *
 * Pure functions, no `expo-location`, so every awkward case — a fix 400m out,
 * an accuracy radius wider than the distance itself, no fix at all — is
 * testable on a laptop instead of by standing in a stairwell.
 *
 * The governing principle from the plan: **capture the truth, never block the
 * carer.** GPS in a stone terrace or a basement flat is unreliable, and a
 * carer standing at the right door must always be able to start their visit.
 * The app records what the sensor said and how confident it was; the agency
 * decides what to make of it. A tool that refuses to let someone work because
 * a satellite disagreed gets abandoned within a week.
 */

/** Metres. Inside this, a check-in is unremarkable. */
export const AT_ADDRESS_RADIUS_M = 150;

/**
 * A fix this vague tells us nothing useful. Reported honestly rather than
 * dressed up as a precise-looking distance.
 */
export const UNUSABLE_ACCURACY_M = 500;

export interface Coords {
  lat: number;
  lng: number;
  /** Radius of uncertainty in metres, as reported by the OS. */
  accuracy?: number | null;
}

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than a projected approximation: it stays accurate at UK
 * latitudes where a degree of longitude is only ~62% of a degree of latitude,
 * which a naive Pythagorean shortcut gets meaningfully wrong.
 */
export function distanceMetres(a: Coords, b: Coords): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export type LocationVerdict =
  /** At the address, as far as anyone can tell. No friction. */
  | { kind: 'at_address'; distanceM: number; accuracyM: number | null }
  /** Away from the address by more than the radius. Ask why, then proceed. */
  | { kind: 'away'; distanceM: number; accuracyM: number | null }
  /** A fix so vague it cannot confirm or deny. Proceed, record the doubt. */
  | { kind: 'unreliable'; distanceM: number; accuracyM: number }
  /** No fix at all — indoors, permission denied, or it timed out. */
  | { kind: 'no_fix'; reason: 'timeout' | 'denied' | 'unavailable' }
  /** We have a fix but no address on file to compare it against. */
  | { kind: 'no_client_location'; accuracyM: number | null };

/**
 * Decides what to tell the carer.
 *
 * Note the ordering: accuracy is judged BEFORE distance. A fix that claims
 * 300m away with a 600m error radius is not evidence of anything, and showing
 * "you're 300m away" would be a confident lie. Saying so plainly is both more
 * honest and more useful to whoever reviews it later.
 */
export function assessLocation(
  device: Coords | null,
  client: { lat: number | null; lng: number | null } | null,
  noFixReason: 'timeout' | 'denied' | 'unavailable' = 'unavailable',
): LocationVerdict {
  if (!device) return { kind: 'no_fix', reason: noFixReason };

  const accuracyM = device.accuracy ?? null;

  if (!client || client.lat === null || client.lng === null) {
    return { kind: 'no_client_location', accuracyM };
  }

  const distanceM = distanceMetres(device, { lat: client.lat, lng: client.lng });

  if (accuracyM !== null && accuracyM >= UNUSABLE_ACCURACY_M) {
    return { kind: 'unreliable', distanceM, accuracyM };
  }

  return {
    kind: distanceM <= AT_ADDRESS_RADIUS_M ? 'at_address' : 'away',
    distanceM,
    accuracyM,
  };
}

/** True when the carer should be asked to pick a reason before continuing. */
export function needsReason(verdict: LocationVerdict): boolean {
  return verdict.kind !== 'at_address';
}

/**
 * Why a check-in happened somewhere unexpected.
 *
 * A fixed list, not free text: it is one tap on a doorstep, it produces data
 * the agency can actually count, and it steers away from the implication that
 * the carer is explaining themselves. Most of these are the office's fault,
 * and the wording says so.
 */
export const AWAY_REASONS = [
  { code: 'wrong_address', label: 'Address on file looks wrong' },
  { code: 'poor_signal', label: 'Poor signal here' },
  { code: 'client_elsewhere', label: 'Visiting them somewhere else' },
  { code: 'client_not_home', label: 'Client not home' },
  { code: 'other', label: 'Something else' },
] as const;

export type AwayReasonCode = (typeof AWAY_REASONS)[number]['code'];

/** The line shown under the check-in button. Plain, never accusatory. */
export function verdictMessage(verdict: LocationVerdict): string {
  switch (verdict.kind) {
    case 'at_address':
      return verdict.distanceM <= 25
        ? 'At the address'
        : `${verdict.distanceM}m from the address`;

    case 'away':
      return `${formatDistance(verdict.distanceM)} from the address`;

    case 'unreliable':
      // Never quote a distance we do not believe.
      return 'Location is rough here — check in anyway and tell us why';

    case 'no_fix':
      return verdict.reason === 'denied'
        ? 'Location is off. You can still check in.'
        : 'No location yet. You can still check in.';

    case 'no_client_location':
      return 'No address on file for this client';
  }
}

/** Metres under a kilometre, then one decimal place. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${metres}m`;
  return `${(metres / 1000).toFixed(1)}km`;
}
