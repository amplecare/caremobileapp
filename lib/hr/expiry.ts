/**
 * Expiry banding for every dated staff compliance record.
 *
 * Shared with the web Agency Hub — this file is a copy of lib/staff/expiry.ts
 * there. The carer sees the same bands for their own documents that their
 * manager sees on the staff list, which matters: nobody should be told their
 * DBS is fine on one screen and expiring on another.
 *
 * DBS certificates, right-to-work documents, training certificates and
 * contracts all share one question: how close is this to lapsing, and how
 * loudly should we say so? The Phase 3 brief names the thresholds — 60 days,
 * 30 days, 7 days, expired — so they live here once and every surface (staff
 * list badge, profile tab, dashboard widget, the alerts engine in Phase 6)
 * reads the same answer.
 *
 * Pure functions, no dates injected from the module scope: `now` is always a
 * parameter so tests can pin it and so a server render and a client render of
 * the same row can't disagree across a midnight boundary.
 *
 * A carer working with an expired DBS is a regulatory breach that can close an
 * agency down, so `expired` is deliberately its own band rather than the
 * bottom of a gradient.
 */

/** Ordered by urgency — `severityRank` depends on this order. */
export const EXPIRY_BANDS = ['valid', 'expiring_60', 'expiring_30', 'expiring_7', 'expired', 'missing'] as const;
export type ExpiryBand = (typeof EXPIRY_BANDS)[number];

export const EXPIRY_THRESHOLDS = { warn: 60, soon: 30, urgent: 7 } as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days from `now` until `date`. Both are floored to midnight first, so
 * "expires tomorrow" is 1 whether it's checked at 09:00 or 23:59 — a partial
 * day rounding the wrong way would make a 7-day alert fire on day 6.
 *
 * Both sides are floored in **UTC**, deliberately and consistently. Expiry
 * columns are Postgres `date` values with no timezone, which `new Date()`
 * parses as UTC midnight; reading `now` with local getters while reading the
 * target with UTC ones makes the result depend on the reader's clock, so the
 * same certificate can band differently on the server (UTC) and in a
 * British-Summer-Time browser. Compliance status must not depend on who is
 * looking or from where.
 */
export function daysUntil(date: string | null, now: Date = new Date()): number | null {
  if (!date) return null;
  const target = new Date(date);
  if (Number.isNaN(target.getTime())) return null;
  const a = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / MS_PER_DAY);
}

/**
 * Bands an expiry date.
 *
 * `null` means "missing", which is treated as its own band rather than as
 * valid: a carer with no DBS record on file is not compliant, and rendering
 * that as a reassuring green tick is exactly the failure this module exists
 * to prevent.
 */
export function expiryBand(expiryDate: string | null, now: Date = new Date()): ExpiryBand {
  const days = daysUntil(expiryDate, now);
  if (days === null) return 'missing';
  if (days < 0) return 'expired';
  if (days <= EXPIRY_THRESHOLDS.urgent) return 'expiring_7';
  if (days <= EXPIRY_THRESHOLDS.soon) return 'expiring_30';
  if (days <= EXPIRY_THRESHOLDS.warn) return 'expiring_60';
  return 'valid';
}

/** Higher means more urgent. Lets callers sort or reduce a set of records. */
export function severityRank(band: ExpiryBand): number {
  switch (band) {
    case 'expired': return 4;
    case 'missing': return 3;
    case 'expiring_7': return 2;
    case 'expiring_30': return 1;
    case 'expiring_60': return 1;
    case 'valid': return 0;
  }
}

/** True when a manager needs to do something. Drives counts and filters. */
export function needsAttention(band: ExpiryBand): boolean {
  return band !== 'valid';
}

/**
 * The worst band across several records — a carer's headline compliance
 * status. An empty list is `missing`, not `valid`: no records on file means
 * nothing has been checked.
 */
export function worstBand(bands: ExpiryBand[]): ExpiryBand {
  if (bands.length === 0) return 'missing';
  return bands.reduce((worst, b) => (severityRank(b) > severityRank(worst) ? b : worst), 'valid' as ExpiryBand);
}

export interface BandPresentation {
  label: string;
  /** Short form for dense table cells. */
  short: string;
  /** Tailwind classes for a pill. */
  pill: string;
  /** Tailwind background for a bar or dot. */
  dot: string;
}

const PRESENTATION: Record<ExpiryBand, BandPresentation> = {
  valid:       { label: 'Valid',        short: 'Valid',   pill: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  expiring_60: { label: 'Expiring soon', short: '60d',    pill: 'bg-sky-50 text-sky-700 border-sky-200',             dot: 'bg-sky-500' },
  expiring_30: { label: 'Expires in 30 days', short: '30d', pill: 'bg-amber-50 text-amber-700 border-amber-200',     dot: 'bg-amber-500' },
  expiring_7:  { label: 'Expires this week',  short: '7d',  pill: 'bg-orange-50 text-orange-700 border-orange-200',  dot: 'bg-orange-500' },
  expired:     { label: 'Expired',      short: 'Expired', pill: 'bg-red-50 text-red-700 border-red-200',             dot: 'bg-red-500' },
  missing:     { label: 'Not on file',  short: 'Missing', pill: 'bg-slate-100 text-slate-600 border-slate-200',      dot: 'bg-slate-400' },
};

export function bandPresentation(band: ExpiryBand): BandPresentation {
  return PRESENTATION[band];
}

/**
 * Human phrasing for a specific date: "Expired 12 days ago",
 * "Expires in 5 days", "Expires today".
 */
export function expiryPhrase(expiryDate: string | null, now: Date = new Date()): string {
  const days = daysUntil(expiryDate, now);
  if (days === null) return 'No expiry recorded';
  if (days === 0) return 'Expires today';
  if (days < 0) {
    const n = Math.abs(days);
    return `Expired ${n} ${n === 1 ? 'day' : 'days'} ago`;
  }
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}
