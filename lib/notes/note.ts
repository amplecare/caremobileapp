/**
 * Care-note rules.
 *
 * Pure functions — no database, no network — covering what a note must
 * contain, and a first-pass scan for things a manager should see today rather
 * than at the next audit.
 *
 * The scan here is DELIBERATELY not the AI. Stage 8 sends audio to Whisper and
 * the transcript to Claude for proper structuring and concern extraction. This
 * runs on the device, offline, in a millisecond, on plain typed text. Its only
 * job is to catch the obvious while the carer is still standing there — if a
 * note says "found her on the floor", the app should ask about an incident
 * report before the carer walks to the next visit, not three days later when
 * a model finally gets to it.
 *
 * It is a prompt, never a gate. A carer can always decline and save the note.
 */

/** Below this a note is a shrug, not a record. */
export const MIN_NOTE_LENGTH = 10;

/** Guards against a stuck key or a pasted document. */
export const MAX_NOTE_LENGTH = 5000;

export type ConcernKind =
  | 'fall'
  | 'pain'
  | 'confusion'
  | 'refusal'
  | 'skin'
  | 'mood'
  | 'safeguarding';

export interface Concern {
  kind: ConcernKind;
  /** The words that triggered it, so the prompt can quote the carer back. */
  matched: string;
  /** Whether this should interrupt, or simply be tagged for the office. */
  urgency: 'prompt' | 'flag';
}

/**
 * Phrases, not single words, wherever ambiguity would cause false positives.
 *
 * "fell" alone matches "fell asleep", which is the single most common phrase
 * in a night-visit note and would train carers to dismiss the prompt within a
 * week. A flag nobody reads is worse than no flag.
 */
const PATTERNS: Array<{ kind: ConcernKind; urgency: Concern['urgency']; re: RegExp }> = [
  {
    kind: 'fall',
    urgency: 'prompt',
    re: /\b(had a fall|has fallen|fell over|fell in|found (?:her|him|them) on the floor|on the floor|slipped and|tripped over)\b/i,
  },
  {
    kind: 'safeguarding',
    urgency: 'prompt',
    re: /\b(bruis\w*|unexplained mark|shout(?:ed|ing) at|afraid of|frightened of|money missing|hit (?:her|him|them))\b/i,
  },
  {
    kind: 'skin',
    urgency: 'prompt',
    re: /\b(pressure (?:sore|ulcer|damage)|red(?:ness)? on (?:her|his|their)|broken skin|skin tear|sore (?:heel|hip|back|bottom))\b/i,
  },
  {
    kind: 'pain',
    urgency: 'flag',
    re: /\b(in pain|complain\w* of pain|sore|aching|discomfort|winc\w+)\b/i,
  },
  {
    kind: 'confusion',
    urgency: 'flag',
    re: /\b(confus\w+|disorient\w+|didn'?t (?:recognise|know) me|more muddled|agitated)\b/i,
  },
  {
    kind: 'refusal',
    urgency: 'flag',
    re: /\b(refus\w+|declined (?:her|his|their)?\s*(?:meds|medication|care|food|personal care)|would not (?:take|let|eat))\b/i,
  },
  {
    kind: 'mood',
    urgency: 'flag',
    re: /\b(low in mood|tearful|very quiet today|withdrawn|upset|anxious)\b/i,
  },
];

/**
 * Scans a note for things worth surfacing now.
 *
 * Order matters: patterns are listed most-serious first and only the first
 * match per kind is kept, so a note mentioning a fall three times prompts
 * once. Nobody dismisses the same dialog twice and keeps reading it.
 */
export function detectConcerns(text: string): Concern[] {
  if (!text.trim()) return [];
  const found: Concern[] = [];
  for (const { kind, urgency, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) found.push({ kind, matched: m[0], urgency });
  }
  return found;
}

/** Only these interrupt the carer before they can move on. */
export function promptingConcerns(concerns: Concern[]): Concern[] {
  return concerns.filter((c) => c.urgency === 'prompt');
}

export const CONCERN_LABELS: Record<ConcernKind, string> = {
  fall: 'a fall',
  pain: 'pain',
  confusion: 'confusion',
  refusal: 'a refusal',
  skin: 'skin damage',
  mood: 'low mood',
  safeguarding: 'a safeguarding concern',
};

/**
 * The question put to the carer. Phrased as a check, never a correction —
 * they were there and we were not.
 */
export function concernPrompt(concerns: Concern[]): string | null {
  const prompting = promptingConcerns(concerns);
  if (prompting.length === 0) return null;

  const list = prompting.map((c) => CONCERN_LABELS[c.kind]);
  const subject =
    list.length === 1
      ? list[0]
      : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;

  return `Your note mentions ${subject}. Do you want to raise an incident report as well?`;
}

export interface NoteValidation {
  valid: boolean;
  /** Shown under the field. Null when there is nothing to say. */
  error: string | null;
  /** Trimmed text, ready to queue. */
  value: string;
}

/**
 * Validates a note at the point of saving.
 *
 * Deliberately permissive: a carer writing "All fine, no concerns" after a
 * fifteen-minute pop-in has written a complete and truthful record, and an app
 * demanding more detail would only teach them to pad it.
 */
export function validateNote(raw: string): NoteValidation {
  const value = raw.trim().replace(/\s+\n/g, '\n');

  if (value.length === 0) {
    return { valid: false, error: 'Write a short note before saving', value };
  }
  if (value.length < MIN_NOTE_LENGTH) {
    return { valid: false, error: 'A few more words — this is the care record', value };
  }
  if (value.length > MAX_NOTE_LENGTH) {
    return {
      valid: false,
      error: `That is longer than ${MAX_NOTE_LENGTH} characters. Split it across visits.`,
      value: value.slice(0, MAX_NOTE_LENGTH),
    };
  }
  return { valid: true, error: null, value };
}

/** Characters remaining, for the counter that appears only near the limit. */
export function charsRemaining(text: string): number {
  return MAX_NOTE_LENGTH - text.trim().length;
}

/** The counter stays hidden until it is actually useful. */
export function shouldShowCounter(text: string): boolean {
  return charsRemaining(text) <= 500;
}
