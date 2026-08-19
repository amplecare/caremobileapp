/**
 * eMAR rules.
 *
 * A wrong entry here is a clinical incident and a CQC finding, so this suite
 * is the strictest in the app. Each test names the real situation it guards.
 */

import {
  DOSE_WINDOW_MINUTES,
  OUTCOMES,
  OUTCOME_LABELS,
  confirmationPrompt,
  doseTiming,
  needsAudit,
  needsSecondConfirmation,
  roundSummary,
  safetyNotes,
  validateAdministration,
  type AdministrationDraft,
  type Medication,
} from '../lib/emar/administration';

function med(over: Partial<Medication> = {}): Medication {
  return {
    id: 'm1',
    name: 'Amlodipine',
    dose: '5mg',
    route: 'Oral',
    isPrn: false,
    isControlledDrug: false,
    isHighRisk: false,
    isCovert: false,
    covertInstructions: null,
    storageInstructions: null,
    scheduledTime: '08:00',
    withFood: false,
    specialInstructions: null,
    ...over,
  };
}

function draft(over: Partial<AdministrationDraft> = {}): AdministrationDraft {
  return {
    outcome: 'administered',
    refusalReason: '',
    notes: '',
    witnessedBy: null,
    secondConfirmation: false,
    ...over,
  };
}

const at = (h: number, m = 0) => new Date(2026, 7, 18, h, m);

describe('outcome vocabulary', () => {
  test('matches the database enum exactly', () => {
    expect([...OUTCOMES]).toEqual(['administered', 'refused', 'missed', 'not_required']);
  });

  /** 'Administered' is a clinical word; a carer reads 'Given'. */
  test('labels are plain English', () => {
    expect(OUTCOME_LABELS.administered).toBe('Given');
    expect(OUTCOME_LABELS.not_required).toBe('Not required');
  });
});

describe('doseTiming', () => {
  test('at the scheduled time it is due', () => {
    expect(doseTiming(med({ scheduledTime: '08:00' }), at(8))).toBe('due');
  });

  test('an hour after is late but still recordable', () => {
    expect(doseTiming(med({ scheduledTime: '08:00' }), at(9))).toBe('late');
  });

  test('beyond the window it is missed', () => {
    expect(doseTiming(med({ scheduledTime: '08:00' }), at(11))).toBe('missed');
  });

  test('well before, it is early — not yet due', () => {
    expect(doseTiming(med({ scheduledTime: '08:00' }), at(4))).toBe('early');
  });

  test('just inside the window either side', () => {
    expect(doseTiming(med({ scheduledTime: '08:00' }), at(6, 5))).toBe('due');
    expect(doseTiming(med({ scheduledTime: '08:00' }), at(9, 59))).toBe('late');
  });

  /**
   * PRN is taken when needed. Showing it as overdue would train carers to
   * ignore genuine overdue warnings.
   */
  test('PRN medication is never due or missed', () => {
    expect(doseTiming(med({ isPrn: true, scheduledTime: null }), at(23))).toBe('not_scheduled');
    expect(doseTiming(med({ isPrn: true, scheduledTime: '08:00' }), at(23))).toBe('not_scheduled');
  });

  test('the window is two hours, matching domiciliary practice', () => {
    expect(DOSE_WINDOW_MINUTES).toBe(120);
  });
});

describe('needsSecondConfirmation', () => {
  test('an ordinary medicine does not', () => {
    expect(needsSecondConfirmation(med(), 'administered')).toBe(false);
  });

  test.each([
    ['controlled drug', { isControlledDrug: true }],
    ['high-risk medicine', { isHighRisk: true }],
    ['covert administration', { isCovert: true }],
  ])('a %s does', (_label, flags) => {
    expect(needsSecondConfirmation(med(flags), 'administered')).toBe(true);
  });

  /** Refusing a controlled drug is not the risky action; giving it is. */
  test('only giving triggers it, not refusing or skipping', () => {
    const cd = med({ isControlledDrug: true });
    expect(needsSecondConfirmation(cd, 'refused')).toBe(false);
    expect(needsSecondConfirmation(cd, 'not_required')).toBe(false);
  });
});

describe('confirmationPrompt', () => {
  test('a controlled drug prompt mentions the CD book', () => {
    expect(confirmationPrompt(med({ isControlledDrug: true, name: 'Morphine' }))).toMatch(/CD book/);
  });

  test('a covert prompt points at the agreed instructions, not the carer', () => {
    const p = confirmationPrompt(med({ isCovert: true }))!;
    expect(p).toMatch(/agreed instructions/i);
    expect(p).not.toMatch(/you decide|your judgement/i);
  });

  test('a high-risk prompt states the dose to check against', () => {
    expect(confirmationPrompt(med({ isHighRisk: true, dose: '10 units' }))).toContain('10 units');
  });

  test('an ordinary medicine has no prompt', () => {
    expect(confirmationPrompt(med())).toBeNull();
  });
});

describe('validateAdministration', () => {
  test('a plain administration passes', () => {
    expect(validateAdministration(med(), draft()).valid).toBe(true);
  });

  /** Nothing is recorded by omission. */
  test('an outcome must be chosen', () => {
    expect(validateAdministration(med(), draft({ outcome: null })).errors.outcome).toBeTruthy();
  });

  /**
   * Not to justify the person's choice — they have every right to decline —
   * but because three refusals of the same medicine in a week is a GP
   * conversation, and the office can only spot that if the reason is there.
   */
  test('a refusal needs a reason', () => {
    const v = validateAdministration(med(), draft({ outcome: 'refused', refusalReason: '  ' }));
    expect(v.errors.refusalReason).toBeTruthy();
  });

  test('a refusal with a reason passes', () => {
    const v = validateAdministration(
      med(),
      draft({ outcome: 'refused', refusalReason: 'Said she felt sick' }),
    );
    expect(v.valid).toBe(true);
  });

  test('the refusal message does not imply the carer failed', () => {
    const v = validateAdministration(med(), draft({ outcome: 'refused' }));
    expect(v.errors.refusalReason).not.toMatch(/fail|should|must/i);
  });

  test('a controlled drug cannot be recorded without the second step', () => {
    const v = validateAdministration(med({ isControlledDrug: true }), draft());
    expect(v.valid).toBe(false);
    expect(v.errors.secondConfirmation).toBeTruthy();
  });

  test('with the confirmation it passes', () => {
    const v = validateAdministration(
      med({ isControlledDrug: true }),
      draft({ secondConfirmation: true }),
    );
    expect(v.valid).toBe(true);
  });
});

describe('needsAudit', () => {
  test('a routine dose does not need review', () => {
    expect(needsAudit(med(), draft())).toBe(false);
  });

  test('refusals and missed doses always do', () => {
    expect(needsAudit(med(), draft({ outcome: 'refused', refusalReason: 'x' }))).toBe(true);
    expect(needsAudit(med(), draft({ outcome: 'missed' }))).toBe(true);
  });

  /**
   * Not wrong — in domiciliary care a second carer usually is not there —
   * but worth an audit entry rather than passing silently.
   */
  test('a controlled drug given with no witness is flagged', () => {
    expect(needsAudit(med({ isControlledDrug: true }), draft({ witnessedBy: null }))).toBe(true);
  });

  test('a witnessed controlled drug is not flagged', () => {
    expect(
      needsAudit(med({ isControlledDrug: true }), draft({ witnessedBy: 'user-2' })),
    ).toBe(false);
  });

  test('every covert administration is flagged', () => {
    expect(needsAudit(med({ isCovert: true }), draft())).toBe(true);
  });
});

describe('safetyNotes', () => {
  test('an ordinary medicine needs no warnings', () => {
    expect(safetyNotes(med())).toEqual([]);
  });

  test('covert instructions come first — they change what the carer does', () => {
    const notes = safetyNotes(
      med({ isCovert: true, covertInstructions: 'Crush and mix into yoghurt', withFood: true }),
    );
    expect(notes[0]).toContain('yoghurt');
  });

  test('a controlled drug is called out', () => {
    expect(safetyNotes(med({ isControlledDrug: true })).join(' ')).toMatch(/CD book/i);
  });

  test('food, storage and special instructions all surface', () => {
    const notes = safetyNotes(
      med({ withFood: true, storageInstructions: 'Keep refrigerated', specialInstructions: 'Do not crush' }),
    ).join(' ');
    expect(notes).toMatch(/with food/i);
    expect(notes).toMatch(/refrigerated/i);
    expect(notes).toMatch(/Do not crush/);
  });
});

describe('roundSummary', () => {
  test('no medication is stated plainly', () => {
    expect(roundSummary([])).toBe('No medication due this visit');
  });

  test('a clean round reads simply', () => {
    expect(roundSummary([{ outcome: 'administered' }, { outcome: 'administered' }])).toBe(
      '2 of 2 given',
    );
  });

  test('refusals are surfaced, not hidden in a total', () => {
    const s = roundSummary([{ outcome: 'administered' }, { outcome: 'refused' }]);
    expect(s).toContain('1 refused');
  });

  test('outstanding doses are counted so nothing is silently skipped', () => {
    const s = roundSummary([{ outcome: 'administered' }, { outcome: null }]);
    expect(s).toContain('1 still to record');
  });
});
