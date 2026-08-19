/**
 * Carer availability, absence and mileage.
 *
 * The HR side of the app: what a carer tells the office about when they can
 * work, when they cannot, and what they are owed for driving.
 *
 * Pure functions. The rules that matter are about not letting a carer submit
 * something the office will have to ring them about — an absence that ends
 * before it starts, a shift already covered, a mileage claim with no visit.
 */

export const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type Day = (typeof DAYS)[number];

export const DAY_LABELS: Record<Day, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

export interface AvailabilityWindow {
  id: string;
  day: Day;
  /** "07:00" */
  start: string;
  /** "14:00" */
  end: string;
}

function minutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export interface WindowValidation {
  valid: boolean;
  error: string | null;
}

/**
 * Validates one availability window.
 *
 * An overnight window (22:00–07:00) is rejected rather than silently split.
 * Night staff genuinely work those hours, but a single row spanning midnight
 * breaks every rota query that asks "who is free on Tuesday" — so the carer
 * is asked to enter it as two, which is what the rota engine can actually use.
 */
export function validateWindow(start: string, end: string): WindowValidation {
  const s = minutes(start);
  const e = minutes(end);

  if (s === null || e === null) {
    return { valid: false, error: 'Enter times as HH:MM, like 07:30' };
  }
  if (s === e) {
    return { valid: false, error: 'Start and finish cannot be the same time' };
  }
  if (e < s) {
    return {
      valid: false,
      error: 'For a night shift, add it as two windows — one to midnight, one from midnight',
    };
  }
  return { valid: true, error: null };
}

/** True when two windows on the same day overlap. Touching ends do not. */
export function windowsOverlap(a: AvailabilityWindow, b: AvailabilityWindow): boolean {
  if (a.day !== b.day) return false;
  const aS = minutes(a.start);
  const aE = minutes(a.end);
  const bS = minutes(b.start);
  const bE = minutes(b.end);
  if (aS === null || aE === null || bS === null || bE === null) return false;
  return aS < bE && bS < aE;
}

/**
 * Finds a clash with what the carer already has.
 *
 * Overlapping availability is not dangerous, just noise the office has to
 * untangle, so this returns the clashing window rather than blocking.
 */
export function findClash(
  existing: AvailabilityWindow[],
  candidate: AvailabilityWindow,
): AvailabilityWindow | null {
  return existing.find((w) => w.id !== candidate.id && windowsOverlap(w, candidate)) ?? null;
}

/** "Mon 07:00–14:00, Tue 07:00–14:00" — the summary on the Me screen. */
export function summariseAvailability(windows: AvailabilityWindow[]): string {
  if (windows.length === 0) return 'No availability set';
  const byDay = DAYS.filter((d) => windows.some((w) => w.day === d));
  return `Available on ${byDay.length} ${byDay.length === 1 ? 'day' : 'days'} a week`;
}

// ---------------------------------------------------------------------------
// Unavailability
// ---------------------------------------------------------------------------

export const ABSENCE_REASONS = [
  { code: 'sickness', label: 'Off sick', needsNotice: false },
  { code: 'holiday', label: 'Holiday', needsNotice: true },
  { code: 'training', label: 'Training', needsNotice: true },
  { code: 'personal', label: 'Personal', needsNotice: true },
  { code: 'bereavement', label: 'Bereavement', needsNotice: false },
  { code: 'other', label: 'Other', needsNotice: true },
] as const;

export type AbsenceReason = (typeof ABSENCE_REASONS)[number]['code'];

/** Days of notice the office asks for on planned absence. */
export const NOTICE_DAYS = 14;

export interface AbsenceValidation {
  valid: boolean;
  error: string | null;
  /** Shown but never blocking — short notice is allowed, just flagged. */
  warning: string | null;
}

/**
 * Validates an absence request.
 *
 * Short notice produces a WARNING, never an error. Someone is not going to
 * plan a bereavement two weeks ahead, and an app that refused the request
 * would simply be bypassed with a phone call — losing the record entirely.
 */
export function validateAbsence(
  reason: AbsenceReason,
  start: Date,
  end: Date,
  now: Date = new Date(),
): AbsenceValidation {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { valid: false, error: 'Pick a start and end date', warning: null };
  }
  if (end < start) {
    return { valid: false, error: 'The end date is before the start date', warning: null };
  }

  const meta = ABSENCE_REASONS.find((r) => r.code === reason);
  let warning: string | null = null;

  if (meta?.needsNotice) {
    const daysAhead = Math.floor((start.getTime() - now.getTime()) / 86_400_000);
    if (daysAhead < NOTICE_DAYS) {
      warning = `That is less than ${NOTICE_DAYS} days' notice. The office may not be able to cover it.`;
    }
  }

  return { valid: true, error: null, warning };
}

/** Whole days inclusive — a single-day absence is 1, not 0. */
export function absenceDays(start: Date, end: Date): number {
  const a = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const b = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((b - a) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// Mileage
// ---------------------------------------------------------------------------

/**
 * HMRC approved mileage rates for cars, 2011/12 onwards: 45p per mile for the
 * first 10,000 business miles in a tax year, 25p thereafter. Reimbursement at
 * or below these rates is tax-free, which is why agencies use them verbatim.
 */
export const HMRC_RATE_FIRST_10K = 0.45;
export const HMRC_RATE_ABOVE_10K = 0.25;
export const HMRC_THRESHOLD_MILES = 10_000;

/**
 * What a claim is worth, accounting for miles already claimed this tax year.
 *
 * A carer crossing the 10,000-mile threshold mid-claim gets the split rate
 * rather than the wrong one for the whole journey.
 */
export function mileageAmount(miles: number, milesAlreadyClaimed = 0): number {
  if (miles <= 0) return 0;

  const remainingAtHighRate = Math.max(0, HMRC_THRESHOLD_MILES - milesAlreadyClaimed);
  const atHighRate = Math.min(miles, remainingAtHighRate);
  const atLowRate = miles - atHighRate;

  const amount = atHighRate * HMRC_RATE_FIRST_10K + atLowRate * HMRC_RATE_ABOVE_10K;
  // Round to whole pence — floating-point pounds in a payroll figure is how
  // a carer ends up 1p short and rings the office about it.
  return Math.round(amount * 100) / 100;
}

export interface MileageValidation {
  valid: boolean;
  error: string | null;
}

/** A single visit-to-visit journey. Anything longer is probably a typo. */
export const MAX_CLAIM_MILES = 200;

export function validateMileage(miles: number): MileageValidation {
  if (!Number.isFinite(miles) || miles <= 0) {
    return { valid: false, error: 'Enter how many miles you drove' };
  }
  if (miles > MAX_CLAIM_MILES) {
    return { valid: false, error: `That is over ${MAX_CLAIM_MILES} miles — check the number` };
  }
  return { valid: true, error: null };
}

/** "12.5 miles · £5.63" */
export function formatClaim(miles: number, milesAlreadyClaimed = 0): string {
  const amount = mileageAmount(miles, milesAlreadyClaimed);
  return `${miles} ${miles === 1 ? 'mile' : 'miles'} · £${amount.toFixed(2)}`;
}
