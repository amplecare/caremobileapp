/**
 * Care-note rules.
 *
 * The concern scan is the risky half: a false negative misses a fall, and a
 * false positive trains carers to dismiss the prompt without reading it.
 * Both failure modes are tested.
 */

import {
  MAX_NOTE_LENGTH,
  charsRemaining,
  concernPrompt,
  detectConcerns,
  promptingConcerns,
  shouldShowCounter,
  validateNote,
} from '../lib/notes/note';

const kinds = (text: string) => detectConcerns(text).map((c) => c.kind);

describe('detectConcerns — catching the serious things', () => {
  test.each([
    ['Doris had a fall in the kitchen this morning.', 'fall'],
    ['Found her on the floor by the bed.', 'fall'],
    ['Noticed bruising to her left arm, she could not say how.', 'safeguarding'],
    ['Redness on her heel, looks like early pressure damage.', 'skin'],
    ['She refused her morning medication again.', 'refusal'],
    ['More confused than usual, didn\'t recognise me at first.', 'confusion'],
    ['Complaining of pain in her hip when standing.', 'pain'],
    ['Very quiet today, seemed withdrawn.', 'mood'],
  ])('%s -> %s', (text, expected) => {
    expect(kinds(text)).toContain(expected);
  });

  test('a fall and skin damage in one note raise both', () => {
    const found = kinds('She had a fall last night and there is broken skin on her elbow.');
    expect(found).toContain('fall');
    expect(found).toContain('skin');
  });
});

describe('detectConcerns — not crying wolf', () => {
  /**
   * The single most common phrase in a night-visit note. Matching bare "fell"
   * would fire on nearly every one, and a prompt that always fires is a prompt
   * nobody reads.
   */
  test('"fell asleep" is not a fall', () => {
    expect(kinds('Settled at 9pm and fell asleep quickly.')).not.toContain('fall');
  });

  test('a routine good visit raises nothing at all', () => {
    expect(detectConcerns('All fine. Made her a cup of tea and we had a chat.')).toEqual([]);
  });

  test('an empty note raises nothing', () => {
    expect(detectConcerns('')).toEqual([]);
    expect(detectConcerns('   ')).toEqual([]);
  });

  test('the same concern mentioned repeatedly prompts once', () => {
    const found = detectConcerns('She had a fall. The fall was in the hall. After the fall she was shaken.');
    expect(found.filter((c) => c.kind === 'fall')).toHaveLength(1);
  });
});

describe('urgency', () => {
  test('falls, safeguarding and skin damage interrupt', () => {
    for (const text of [
      'She had a fall.',
      'Unexplained mark on her wrist.',
      'Pressure sore on her heel.',
    ]) {
      expect(promptingConcerns(detectConcerns(text)).length).toBeGreaterThan(0);
    }
  });

  /** Worth recording, not worth stopping a carer mid-shift for. */
  test('mood and pain are flagged but do not interrupt', () => {
    expect(promptingConcerns(detectConcerns('Seemed a bit tearful today.'))).toEqual([]);
    expect(promptingConcerns(detectConcerns('Some discomfort when moving.'))).toEqual([]);
  });
});

describe('concernPrompt', () => {
  test('a routine note produces no prompt', () => {
    expect(concernPrompt(detectConcerns('All well today.'))).toBeNull();
  });

  test('one concern reads naturally', () => {
    const p = concernPrompt(detectConcerns('She had a fall in the hallway.'));
    expect(p).toBe('Your note mentions a fall. Do you want to raise an incident report as well?');
  });

  test('two concerns are joined with "and", not a comma', () => {
    const p = concernPrompt(detectConcerns('She had a fall and there is broken skin on her arm.'));
    expect(p).toMatch(/ and /);
    expect(p).not.toMatch(/, and/);
  });

  /** The carer was there and we were not. Nothing here may sound corrective. */
  test('the prompt asks, it does not instruct', () => {
    const p = concernPrompt(detectConcerns('Found her on the floor.'))!;
    expect(p).toMatch(/\?$/);
    expect(p).not.toMatch(/must|should have|failed|required/i);
  });
});

describe('validateNote', () => {
  test('an empty note cannot be saved', () => {
    expect(validateNote('').valid).toBe(false);
    expect(validateNote('    ').valid).toBe(false);
  });

  test('a couple of characters is not a record', () => {
    expect(validateNote('ok').valid).toBe(false);
  });

  /**
   * A fifteen-minute pop-in genuinely can be "all fine". Demanding more would
   * only teach carers to pad the record.
   */
  test('a short but complete note is accepted', () => {
    const v = validateNote('All fine, no concerns.');
    expect(v.valid).toBe(true);
    expect(v.error).toBeNull();
  });

  test('surrounding whitespace is trimmed off what gets saved', () => {
    expect(validateNote('   Doris slept well.   ').value).toBe('Doris slept well.');
  });

  test('an absurdly long note is refused and truncated for safety', () => {
    const v = validateNote('x'.repeat(MAX_NOTE_LENGTH + 500));
    expect(v.valid).toBe(false);
    expect(v.value.length).toBe(MAX_NOTE_LENGTH);
  });

  test('a note exactly at the limit is fine', () => {
    expect(validateNote('x'.repeat(MAX_NOTE_LENGTH)).valid).toBe(true);
  });
});

describe('character counter', () => {
  test('hidden for a normal note', () => {
    expect(shouldShowCounter('Doris slept well and ate breakfast.')).toBe(false);
  });

  test('appears only as the limit approaches', () => {
    expect(shouldShowCounter('x'.repeat(MAX_NOTE_LENGTH - 100))).toBe(true);
  });

  test('counts down accurately', () => {
    expect(charsRemaining('12345')).toBe(MAX_NOTE_LENGTH - 5);
  });
});
