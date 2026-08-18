/**
 * Visit photo rules.
 *
 * Photos are the heaviest thing the outbox moves, and a queue clogged with
 * 5MB JPEGs strands the care notes behind them. These rules exist to stop
 * that, and to keep the app honest about what has actually been sent.
 */

import {
  MAX_BYTES,
  MAX_EDGE_PX,
  MAX_PHOTOS_PER_VISIT,
  canAddPhoto,
  checkSize,
  formatBytes,
  photoStatusLabel,
  storagePath,
  type PendingPhoto,
} from '../lib/media/photo';

function photo(over: Partial<PendingPhoto> = {}): PendingPhoto {
  return {
    id: 'p1',
    visitId: 'v1',
    localUri: 'file:///tmp/p1.jpg',
    mimeType: 'image/jpeg',
    bytes: 400_000,
    caption: null,
    createdAt: 1_760_000_000_000,
    remoteUrl: null,
    ...over,
  };
}

describe('sizing constants', () => {
  /** Enough to read a medication label; small enough to actually arrive. */
  test('the long edge is large enough to be clinically useful', () => {
    expect(MAX_EDGE_PX).toBeGreaterThanOrEqual(1200);
  });

  test('the hard ceiling is small enough not to strand the queue', () => {
    expect(MAX_BYTES).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});

describe('canAddPhoto', () => {
  test('an empty visit accepts a photo', () => {
    expect(canAddPhoto([]).ok).toBe(true);
  });

  test('a few photos is fine', () => {
    expect(canAddPhoto([photo(), photo({ id: 'p2' })]).ok).toBe(true);
  });

  /**
   * The cap protects the queue, not disk space: every photo is a job later
   * work has to drain behind.
   */
  test('the cap stops a carer disabling their own sync', () => {
    const full = Array.from({ length: MAX_PHOTOS_PER_VISIT }, (_, i) => photo({ id: `p${i}` }));
    const result = canAddPhoto(full);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(String(MAX_PHOTOS_PER_VISIT));
  });

  test('the refusal explains itself rather than just failing', () => {
    const full = Array.from({ length: MAX_PHOTOS_PER_VISIT }, (_, i) => photo({ id: `p${i}` }));
    const result = canAddPhoto(full);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(20);
  });
});

describe('checkSize', () => {
  test('a compressed photo passes', () => {
    expect(checkSize(400_000).ok).toBe(true);
  });

  test('exactly at the ceiling is allowed', () => {
    expect(checkSize(MAX_BYTES).ok).toBe(true);
  });

  test('an oversized file is refused with an actionable message', () => {
    const result = checkSize(MAX_BYTES + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/again/i);
  });
});

describe('storagePath', () => {
  /** The bucket policy matches on the first segment. */
  test('is organisation-scoped so RLS can isolate agencies', () => {
    expect(storagePath('org-1', 'v1', 'p1')).toMatch(/^org-1\//);
  });

  test('groups by visit', () => {
    expect(storagePath('org-1', 'v9', 'p3')).toBe('org-1/v9/p3.jpg');
  });

  /** A retry overwrites the same object instead of creating a duplicate. */
  test('the same photo always resolves to the same path', () => {
    expect(storagePath('org-1', 'v1', 'p1')).toBe(storagePath('org-1', 'v1', 'p1'));
  });

  test('different photos never collide', () => {
    expect(storagePath('org-1', 'v1', 'p1')).not.toBe(storagePath('org-1', 'v1', 'p2'));
  });
});

describe('formatBytes', () => {
  test.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [400_000, '391 KB'],
    [2_516_582, '2.4 MB'],
  ])('%i formats as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('photoStatusLabel', () => {
  /**
   * Saying "uploaded" before the file has left the device would be a lie a
   * carer might repeat to a manager asking whether a wound was documented.
   */
  test('a queued photo is described as on the phone, not sent', () => {
    expect(photoStatusLabel(photo())).toBe('Saved on this phone');
  });

  test('only a delivered photo reads as sent', () => {
    expect(photoStatusLabel(photo({ remoteUrl: 'https://cdn/x.jpg' }))).toBe('Sent');
  });
});
