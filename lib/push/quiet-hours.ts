/**
 * Do-not-disturb hours.
 *
 * A carer who works mornings should not be woken at 23:00 by a rota change
 * for next Tuesday. But the point is to suppress *noise*, never to make
 * someone unreachable: urgent messages and safeguarding escalations ignore
 * the window entirely, by design.
 *
 * Pure functions. The awkward case — a window that crosses midnight, which is
 * the normal one for night staff — is where this earns its tests.
 */

export interface QuietHours {
  /** "22:00". Null when the carer has not set any. */
  start: string | null;
  /** "07:00" */
  end: string | null;
}

/** Alerts that always get through, whatever the hour. */
export type AlertUrgency = 'routine' | 'urgent';

/** Minutes since midnight, or null if unparseable. */
function toMinutes(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `at` inside the quiet window?
 *
 * Handles the crossing-midnight case, which is the common one: 22:00–07:00 is
 * two ranges either side of midnight, not one empty range. Getting this
 * backwards would silence alerts all day and deliver them all night — the
 * exact opposite of the intent.
 */
export function isQuietNow(quiet: QuietHours, at: Date = new Date()): boolean {
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === null || end === null) return false;
  if (start === end) return false; // a zero-length window silences nothing

  const now = at.getHours() * 60 + at.getMinutes();

  return start < end
    ? now >= start && now < end // same-day window, e.g. 13:00–14:00
    : now >= start || now < end; // crosses midnight, e.g. 22:00–07:00
}

/**
 * Whether a notification should make a sound right now.
 *
 * Note it is never "drop the notification" — a suppressed alert still arrives
 * silently and is waiting when the carer next looks. Losing it entirely would
 * mean a rota change nobody saw.
 */
export function shouldPlaySound(
  quiet: QuietHours,
  urgency: AlertUrgency,
  at: Date = new Date(),
): boolean {
  if (urgency === 'urgent') return true;
  return !isQuietNow(quiet, at);
}

/** Plain description for the settings screen. */
export function describeQuietHours(quiet: QuietHours): string {
  if (!quiet.start || !quiet.end) return 'Notifications always make a sound';
  return `Silent between ${quiet.start} and ${quiet.end}. Urgent alerts still come through.`;
}
