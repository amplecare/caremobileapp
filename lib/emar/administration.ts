/**
 * eMAR — rules for recording medication administration.
 *
 * The highest-stakes code in this app. A wrong entry here is a clinical
 * incident and a CQC finding, so the rules are deliberately conservative and
 * every one of them is tested.
 *
 * Three principles:
 *
 *   1. Nothing is recorded by omission. A dose is only 'missed' when someone
 *      says so or the window closes — never as a side effect of the carer
 *      navigating away.
 *   2. The riskier the drug, the slower the interaction. Controlled drugs and
 *      high-risk medicines require an extra deliberate step.
 *   3. Refusals are first-class. A person declining their medication is
 *      exercising a right, not causing an error, and the record must capture
 *      why without implying fault.
 *
 * Pure functions — no database, no clock beyond what is passed in.
 */

/** Matches the `medication_outcome` enum exactly. */
export const OUTCOMES = ['administered', 'refused', 'missed', 'not_required'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** What the carer sees. 'administered' is a clinical word, 'Given' is not. */
export const OUTCOME_LABELS: Record<Outcome, string> = {
  administered: 'Given',
  refused: 'Refused',
  missed: 'Missed',
  not_required: 'Not required',
};

export interface Medication {
  id: string;
  name: string;
  dose: string | null;
  route: string | null;
  isPrn: boolean;
  isControlledDrug: boolean;
  isHighRisk: boolean;
  isCovert: boolean;
  covertInstructions: string | null;
  storageInstructions: string | null;
  /** "08:00" for a scheduled dose; null for PRN. */
  scheduledTime: string | null;
  withFood: boolean;
  specialInstructions: string | null;
}

/**
 * How late a dose may be given before it stops being that dose.
 *
 * Two hours is the widely used domiciliary window: earlier risks doubling up
 * with the previous round, later means the next one is nearly due. Outside it
 * the carer can still record something, but it is flagged as late.
 */
export const DOSE_WINDOW_MINUTES = 120;

export type DoseTiming = 'due' | 'early' | 'late' | 'missed' | 'not_scheduled';

/** Minutes since midnight from "HH:MM", or null. */
function minutesOf(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (h > 23 || mins > 59) return null;
  return h * 60 + mins;
}

/**
 * Where this dose sits relative to now.
 *
 * PRN medication is never "due" — it is taken when needed, and showing it as
 * overdue would train carers to ignore genuine overdue warnings.
 */
export function doseTiming(med: Medication, now: Date = new Date()): DoseTiming {
  if (med.isPrn) return 'not_scheduled';

  const scheduled = minutesOf(med.scheduledTime);
  if (scheduled === null) return 'not_scheduled';

  const current = now.getHours() * 60 + now.getMinutes();
  const delta = current - scheduled;

  if (delta < -DOSE_WINDOW_MINUTES) return 'early';
  if (delta <= 0) return 'due';
  if (delta <= DOSE_WINDOW_MINUTES) return 'late';
  return 'missed';
}

export interface AdministrationDraft {
  outcome: Outcome | null;
  refusalReason: string;
  notes: string;
  witnessedBy: string | null;
  /** Set true only after the carer confirms the extra step. */
  secondConfirmation: boolean;
}

export interface AdministrationValidation {
  valid: boolean;
  errors: Partial<Record<'outcome' | 'refusalReason' | 'secondConfirmation' | 'witness', string>>;
}

/**
 * Whether this medication needs a deliberate second step.
 *
 * Controlled drugs and high-risk medicines get one. Covert administration
 * does too — a carer hiding medication in food should have to actively
 * confirm they are following a documented decision, not tap through.
 */
export function needsSecondConfirmation(med: Medication, outcome: Outcome | null): boolean {
  if (outcome !== 'administered') return false;
  return med.isControlledDrug || med.isHighRisk || med.isCovert;
}

/** The wording of that confirmation, specific to why it is being asked. */
export function confirmationPrompt(med: Medication): string | null {
  if (med.isControlledDrug) {
    return `${med.name} is a controlled drug. Confirm you have given ${med.dose ?? 'the dose'} and recorded it in the CD book.`;
  }
  if (med.isCovert) {
    return `${med.name} is authorised to be given covertly. Confirm you are following the agreed instructions.`;
  }
  if (med.isHighRisk) {
    return `${med.name} is a high-risk medicine. Confirm the dose is ${med.dose ?? 'as prescribed'}.`;
  }
  return null;
}

/**
 * Validates an entry before it is recorded.
 *
 * A refusal must carry a reason — not to justify the person's choice, but
 * because the office needs to spot a pattern. Three refusals of the same
 * medicine in a week is a GP conversation.
 */
export function validateAdministration(
  med: Medication,
  draft: AdministrationDraft,
): AdministrationValidation {
  const errors: AdministrationValidation['errors'] = {};

  if (!draft.outcome) {
    errors.outcome = 'Record what happened with this medicine';
  }

  if (draft.outcome === 'refused' && draft.refusalReason.trim().length === 0) {
    errors.refusalReason = 'Add a short reason — it helps spot a pattern';
  }

  if (needsSecondConfirmation(med, draft.outcome) && !draft.secondConfirmation) {
    errors.secondConfirmation = 'Please confirm before recording this one';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Whether the administration should be flagged for the office to review.
 *
 * A controlled drug given without a witness is not wrong — in domiciliary
 * care a second carer usually is not there — but it is worth an audit trail
 * entry rather than passing silently.
 */
export function needsAudit(med: Medication, draft: AdministrationDraft): boolean {
  if (draft.outcome === 'refused' || draft.outcome === 'missed') return true;
  if (med.isControlledDrug && !draft.witnessedBy) return true;
  if (med.isCovert && draft.outcome === 'administered') return true;
  return false;
}

/** Anything the carer must read before giving this dose, in priority order. */
export function safetyNotes(med: Medication): string[] {
  const notes: string[] = [];
  if (med.isCovert) {
    notes.push(
      med.covertInstructions
        ? `Covert: ${med.covertInstructions}`
        : 'Covert administration is authorised for this medicine.',
    );
  }
  if (med.isControlledDrug) notes.push('Controlled drug — record in the CD book.');
  if (med.isHighRisk) notes.push('High-risk medicine — check the dose carefully.');
  if (med.withFood) notes.push('Give with food.');
  if (med.specialInstructions) notes.push(med.specialInstructions);
  if (med.storageInstructions) notes.push(`Storage: ${med.storageInstructions}`);
  return notes;
}

/** Round summary for the visit screen: "2 of 4 given, 1 refused". */
export function roundSummary(entries: Array<{ outcome: Outcome | null }>): string {
  const total = entries.length;
  if (total === 0) return 'No medication due this visit';

  const count = (o: Outcome) => entries.filter((e) => e.outcome === o).length;
  const given = count('administered');
  const refused = count('refused');
  const outstanding = entries.filter((e) => e.outcome === null).length;

  const parts = [`${given} of ${total} given`];
  if (refused > 0) parts.push(`${refused} refused`);
  if (outstanding > 0) parts.push(`${outstanding} still to record`);
  return parts.join(', ');
}
