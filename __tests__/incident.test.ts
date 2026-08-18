/**
 * Incident rules.
 *
 * The safeguarding and CQC-notification flags carry legal weight, so they are
 * derived from the category rather than left to a tick-box. These tests pin
 * the direction the system is allowed to be wrong in: escalating too much,
 * never too little.
 */

import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  INCIDENT_CATEGORIES,
  MIN_DESCRIPTION,
  deriveFlags,
  needsImmediateCall,
  orderedCategories,
  validateIncident,
  type IncidentCategory,
  type IncidentDraft,
} from '../lib/incidents/incident';

function draft(over: Partial<IncidentDraft> = {}): IncidentDraft {
  return {
    category: 'fall',
    description: 'Found Doris sitting on the bedroom floor beside her bed.',
    immediateAction: '',
    carerFlaggedSafeguarding: false,
    ...over,
  };
}

describe('deriveFlags — safeguarding', () => {
  test.each(['safeguarding', 'abuse', 'missing_person', 'pressure_sore'] as IncidentCategory[])(
    '%s is always a safeguarding matter',
    (category) => {
      expect(deriveFlags(category).isSafeguarding).toBe(true);
    },
  );

  test('a complaint is not, on its own', () => {
    expect(deriveFlags('complaint').isSafeguarding).toBe(false);
  });

  /** The carer was there. Their judgement beats our lookup table. */
  test('a carer can always escalate something we did not classify', () => {
    expect(deriveFlags('complaint', true).isSafeguarding).toBe(true);
  });

  /**
   * The asymmetry that matters: the flag can be turned ON by a carer but
   * never OFF. Leaving a box unticked must not switch off an escalation the
   * category requires.
   */
  test('a carer cannot un-flag a category that demands it', () => {
    expect(deriveFlags('abuse', false).isSafeguarding).toBe(true);
  });
});

describe('deriveFlags — CQC notification', () => {
  test('anything safeguarding is also reportable', () => {
    for (const c of ['safeguarding', 'abuse', 'missing_person'] as IncidentCategory[]) {
      const f = deriveFlags(c);
      expect(f.isSafeguarding && f.isReportable).toBe(true);
    }
  });

  /**
   * A fall is only statutorily notifiable if it caused serious injury, and a
   * carer at the door cannot assess that. Flagging every fall for the office
   * to triage is the safe direction to be wrong in.
   */
  test('every fall is flagged for the office to triage', () => {
    expect(deriveFlags('fall').isReportable).toBe(true);
  });

  test('medication errors are reportable', () => {
    expect(deriveFlags('medication_error').isReportable).toBe(true);
  });

  test('a near miss is recorded but not escalated', () => {
    const f = deriveFlags('near_miss');
    expect(f.isSafeguarding).toBe(false);
    expect(f.isReportable).toBe(false);
  });

  test('escalating a near miss by hand makes it reportable too', () => {
    expect(deriveFlags('near_miss', true).isReportable).toBe(true);
  });
});

describe('the carer is told what will happen', () => {
  test('a safeguarding report says so plainly', () => {
    expect(deriveFlags('abuse').explanation).toMatch(/safeguarding/i);
  });

  test('a reportable one explains the manager will review it', () => {
    expect(deriveFlags('fall').explanation).toMatch(/manager/i);
  });

  test('a routine report says nothing rather than inventing reassurance', () => {
    expect(deriveFlags('near_miss').explanation).toBeNull();
  });

  test('no explanation blames the carer', () => {
    for (const c of INCIDENT_CATEGORIES) {
      const e = deriveFlags(c).explanation;
      if (e) expect(e).not.toMatch(/you (?:failed|should|must)/i);
    }
  });
});

describe('needsImmediateCall', () => {
  test('safeguarding warrants a phone call, not just a queued report', () => {
    expect(needsImmediateCall(deriveFlags('abuse'))).toBe(true);
  });

  test('a routine fall does not', () => {
    expect(needsImmediateCall(deriveFlags('near_miss'))).toBe(false);
  });
});

describe('validateIncident', () => {
  test('a complete report passes', () => {
    expect(validateIncident(draft()).valid).toBe(true);
  });

  test('a category must be chosen', () => {
    expect(validateIncident(draft({ category: null })).errors.category).toBeTruthy();
  });

  test('an empty description is refused', () => {
    expect(validateIncident(draft({ description: '   ' })).errors.description).toBeTruthy();
  });

  /**
   * Stricter than a care note on purpose: an incident may be read by a
   * safeguarding board or a coroner. "She fell" is not enough for either.
   */
  test('a two-word description is not enough', () => {
    const v = validateIncident(draft({ description: 'She fell' }));
    expect(v.valid).toBe(false);
    expect(v.errors.description).toBeTruthy();
  });

  test('the threshold is modest, not obstructive', () => {
    expect(MIN_DESCRIPTION).toBeLessThanOrEqual(40);
  });

  /** For these, doing nothing would itself be the failing. */
  test('safeguarding reports must record what was done at the time', () => {
    const v = validateIncident(draft({ category: 'abuse', immediateAction: '' }));
    expect(v.errors.immediateAction).toBeTruthy();
  });

  test('a fall does not demand an immediate action field', () => {
    expect(validateIncident(draft({ category: 'fall', immediateAction: '' })).valid).toBe(true);
  });

  test('a safeguarding report with an action passes', () => {
    const v = validateIncident(
      draft({
        category: 'abuse',
        description: 'Unexplained bruising to both upper arms, in a grip pattern.',
        immediateAction: 'Stayed with her, called the office and the district nurse.',
      }),
    );
    expect(v.valid).toBe(true);
  });
});

describe('category presentation', () => {
  test('every category has a label and a hint', () => {
    for (const c of INCIDENT_CATEGORIES) {
      expect(CATEGORY_LABELS[c]).toBeTruthy();
      expect(CATEGORY_HINTS[c]).toBeTruthy();
    }
  });

  test('labels are plain words, not enum names', () => {
    for (const c of INCIDENT_CATEGORIES) {
      expect(CATEGORY_LABELS[c]).not.toMatch(/_/);
    }
  });

  test('the common ones come first', () => {
    expect(orderedCategories().slice(0, 4)).toEqual([
      'fall',
      'injury',
      'medication_error',
      'safeguarding',
    ]);
  });

  test('ordering loses nothing', () => {
    expect(orderedCategories().sort()).toEqual([...INCIDENT_CATEGORIES].sort());
  });
});
