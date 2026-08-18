/**
 * Incident reporting rules.
 *
 * A carer reports what happened; this decides what that means. Two of those
 * decisions carry legal weight and must not be left to whoever is filling the
 * form at 7am:
 *
 *   is_safeguarding — triggers the agency's safeguarding process and, in most
 *     cases, a referral to the local authority under the Care Act 2014.
 *   is_reportable   — CQC must be notified of certain events under Regulation
 *     18 of the Registration Regulations 2009, on a statutory timescale.
 *
 * Getting either wrong is a regulatory failure, so they are derived from the
 * category rather than left as tick-boxes a tired carer might miss. The carer
 * can always ADD a safeguarding flag — their judgement beats our lookup table
 * — but they cannot accidentally remove one the category demands.
 *
 * This is not legal advice encoded in software. It is a safe default that
 * escalates too much rather than too little, and the office reviews every one.
 */

export const INCIDENT_CATEGORIES = [
  'fall',
  'medication_error',
  'safeguarding',
  'near_miss',
  'complaint',
  'injury',
  'behaviour',
  'missing_person',
  'abuse',
  'pressure_sore',
  'other',
] as const;

export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

/** Plain words. A carer picking a category should not have to decode jargon. */
export const CATEGORY_LABELS: Record<IncidentCategory, string> = {
  fall: 'A fall',
  medication_error: 'Medication error',
  safeguarding: 'Safeguarding concern',
  near_miss: 'Near miss',
  complaint: 'Complaint',
  injury: 'Injury',
  behaviour: 'Behaviour incident',
  missing_person: 'Person missing',
  abuse: 'Suspected abuse',
  pressure_sore: 'Pressure sore',
  other: 'Something else',
};

/** One line of help, so the right category is obvious under pressure. */
export const CATEGORY_HINTS: Record<IncidentCategory, string> = {
  fall: 'Found on the floor, slipped, or a witnessed fall',
  medication_error: 'Wrong dose, missed dose, or given at the wrong time',
  safeguarding: 'Anything that puts the person at risk of harm or neglect',
  near_miss: 'Something that almost went wrong',
  complaint: 'The person or their family raised a concern',
  injury: 'A cut, burn, bruise or other harm',
  behaviour: 'Distressed or challenging behaviour',
  missing_person: 'You could not locate the person',
  abuse: 'Physical, financial, emotional or neglect',
  pressure_sore: 'New or worsening skin damage',
  other: 'Anything that does not fit above',
};

/**
 * Categories that are always a safeguarding matter, regardless of what the
 * carer ticks. Abuse and a missing person are unambiguous; a pressure sore is
 * included because a grade 3 or above is reportable neglect and the carer at
 * the door cannot reliably grade it.
 */
const ALWAYS_SAFEGUARDING: ReadonlySet<IncidentCategory> = new Set([
  'safeguarding',
  'abuse',
  'missing_person',
  'pressure_sore',
]);

/**
 * Categories that always warrant a CQC notification.
 *
 * Deliberately wider than the strict statutory list: a fall is only notifiable
 * if it caused serious injury, and a carer cannot assess that. Flagging every
 * fall for the office to triage is the safe direction to be wrong in.
 */
const ALWAYS_REPORTABLE: ReadonlySet<IncidentCategory> = new Set([
  'safeguarding',
  'abuse',
  'missing_person',
  'pressure_sore',
  'injury',
  'fall',
  'medication_error',
]);

export interface IncidentFlags {
  isSafeguarding: boolean;
  isReportable: boolean;
  /** Shown to the carer so the consequence of their choice is never hidden. */
  explanation: string | null;
}

/**
 * Derives the flags.
 *
 * `carerFlaggedSafeguarding` can only ever turn the flag ON. A carer who
 * senses something is wrong overrides the table; a carer who leaves the box
 * unticked cannot switch off an escalation the category requires.
 */
export function deriveFlags(
  category: IncidentCategory,
  carerFlaggedSafeguarding = false,
): IncidentFlags {
  const isSafeguarding = ALWAYS_SAFEGUARDING.has(category) || carerFlaggedSafeguarding;
  const isReportable = ALWAYS_REPORTABLE.has(category) || isSafeguarding;

  let explanation: string | null = null;
  if (isSafeguarding) {
    explanation = 'This will be raised as a safeguarding concern and sent to your manager straight away.';
  } else if (isReportable) {
    explanation = 'Your manager will review this and decide whether CQC need to be told.';
  }

  return { isSafeguarding, isReportable, explanation };
}

/** True when the office should be telephoned as well, not just notified. */
export function needsImmediateCall(flags: IncidentFlags): boolean {
  return flags.isSafeguarding;
}

export interface IncidentDraft {
  category: IncidentCategory | null;
  description: string;
  immediateAction: string;
  carerFlaggedSafeguarding: boolean;
}

export interface IncidentValidation {
  valid: boolean;
  errors: Partial<Record<'category' | 'description' | 'immediateAction', string>>;
}

/** Enough detail that someone reading it next week understands what happened. */
export const MIN_DESCRIPTION = 20;

/**
 * Validates a report.
 *
 * Stricter than a care note on purpose: a note is a routine record, an
 * incident may be read by a safeguarding board or a coroner. "She fell" is
 * not enough for either.
 */
export function validateIncident(draft: IncidentDraft): IncidentValidation {
  const errors: IncidentValidation['errors'] = {};

  if (!draft.category) {
    errors.category = 'Pick what happened';
  }

  const description = draft.description.trim();
  if (description.length === 0) {
    errors.description = 'Describe what happened';
  } else if (description.length < MIN_DESCRIPTION) {
    errors.description = 'A bit more detail — someone will read this next week';
  }

  // Only demanded where inaction would itself be the failing.
  if (draft.category && ALWAYS_SAFEGUARDING.has(draft.category)) {
    if (draft.immediateAction.trim().length === 0) {
      errors.immediateAction = 'What did you do at the time?';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Categories offered first — the ones carers actually report most. */
export function orderedCategories(): IncidentCategory[] {
  const common: IncidentCategory[] = ['fall', 'injury', 'medication_error', 'safeguarding'];
  return [...common, ...INCIDENT_CATEGORIES.filter((c) => !common.includes(c))];
}
