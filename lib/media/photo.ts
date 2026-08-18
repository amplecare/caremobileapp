/**
 * Visit photo rules.
 *
 * Photos are evidence — a pressure sore, a completed meal, a damaged
 * doorframe — and they are the heaviest thing this app moves. A 12MP phone
 * camera produces a 4–6MB JPEG; a carer on rural 3G with ten of those queued
 * will never drain the outbox, and their care notes are stuck behind them.
 *
 * So everything here is about keeping photos small enough to actually arrive,
 * and about being honest that a queued photo is not yet delivered.
 *
 * Pure functions — the picker and the upload live in the screen and the
 * sender respectively.
 */

/**
 * Longest edge after resize.
 *
 * 1600px is comfortably enough to see a skin tear or read a medication label
 * on a phone or a manager's laptop, and takes a typical photo from ~5MB to
 * ~400KB. Full resolution buys clinical detail nobody is zooming in for, at
 * ten times the upload.
 */
export const MAX_EDGE_PX = 1600;

/** JPEG quality. 0.7 is where artefacts stop being visible at arm's length. */
export const JPEG_QUALITY = 0.7;

/** Hard ceiling after compression. Beyond this something has gone wrong. */
export const MAX_BYTES = 3 * 1024 * 1024;

/** More than this per visit is a filing cabinet, not a care record. */
export const MAX_PHOTOS_PER_VISIT = 10;

export interface PendingPhoto {
  /** Client-generated; becomes the outbox job id and the storage filename. */
  id: string;
  visitId: string;
  /** Local file:// URI. Valid only on this device until uploaded. */
  localUri: string;
  mimeType: string;
  bytes: number;
  caption: string | null;
  createdAt: number;
  /** Set once the file reaches Supabase storage. */
  remoteUrl: string | null;
}

export interface PhotoRejection {
  ok: false;
  reason: string;
}
export type PhotoCheck = { ok: true } | PhotoRejection;

/**
 * Whether another photo may be added.
 *
 * The cap is about the queue, not about storage cost: each photo is a job
 * that has to drain before later ones, and a carer who takes thirty pictures
 * of a garden has effectively disabled their own sync.
 */
export function canAddPhoto(existing: PendingPhoto[]): PhotoCheck {
  if (existing.length >= MAX_PHOTOS_PER_VISIT) {
    return {
      ok: false,
      reason: `You can attach up to ${MAX_PHOTOS_PER_VISIT} photos to a visit.`,
    };
  }
  return { ok: true };
}

/** Whether a compressed file is small enough to queue. */
export function checkSize(bytes: number): PhotoCheck {
  if (bytes > MAX_BYTES) {
    return {
      ok: false,
      reason: 'That photo is too large to send. Try taking it again.',
    };
  }
  return { ok: true };
}

/**
 * Storage path for a photo.
 *
 * Organisation-scoped so the bucket's RLS policy — which matches on the first
 * path segment — keeps one agency's photos unreachable from another's session.
 * The job id is the filename, which makes the upload idempotent for free: a
 * retry overwrites the same object rather than creating a second copy.
 */
export function storagePath(organisationId: string, visitId: string, photoId: string): string {
  return `${organisationId}/${visitId}/${photoId}.jpg`;
}

/** "2.4 MB" / "812 KB" — shown next to a queued photo so size is visible. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What the carer is told about a photo's state.
 *
 * "Saved on this phone" is the honest description of a queued photo. Saying
 * "uploaded" before it has left the device would be a lie the carer might
 * rely on when a manager asks whether the wound was documented.
 */
export function photoStatusLabel(photo: PendingPhoto): string {
  return photo.remoteUrl ? 'Sent' : 'Saved on this phone';
}
