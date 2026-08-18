/**
 * Visit task checklist.
 *
 * Task completions are the evidence that commissioned care was actually
 * delivered, so the rules about what "done" means are pinned here.
 */

import {
  checkoutWarning,
  orderForDisplay,
  progressLabel,
  progressOf,
  toggleTask,
  type VisitTask,
} from '../lib/tasks/checklist';

const NOW = 1_760_000_000_000;

function task(over: Partial<VisitTask> = {}): VisitTask {
  return {
    id: 't1',
    visitId: 'v1',
    label: 'Assist with personal care',
    sortOrder: 0,
    completedAt: null,
    notes: null,
    ...over,
  };
}

describe('progressOf', () => {
  test('counts what is done and what is left', () => {
    const p = progressOf([
      task({ id: 'a', completedAt: NOW }),
      task({ id: 'b' }),
      task({ id: 'c' }),
    ]);
    expect(p).toMatchObject({ total: 3, done: 1, percent: 33, complete: false });
    expect(p.remaining.map((t) => t.id)).toEqual(['b', 'c']);
  });

  /** A welfare check with no care-plan tasks is normal, not an error. */
  test('an empty checklist is 0% and never NaN', () => {
    const p = progressOf([]);
    expect(p.percent).toBe(0);
    expect(Number.isNaN(p.percent)).toBe(false);
    expect(p.total).toBe(0);
  });

  test('an empty checklist is not "complete"', () => {
    // Nothing was asked, so nothing was achieved — claiming completion would
    // be misleading evidence.
    expect(progressOf([]).complete).toBe(false);
  });

  test('all ticked reads as complete at 100%', () => {
    const p = progressOf([
      task({ id: 'a', completedAt: NOW }),
      task({ id: 'b', completedAt: NOW }),
    ]);
    expect(p).toMatchObject({ percent: 100, complete: true });
    expect(p.remaining).toEqual([]);
  });

  test('remaining tasks keep care-plan order', () => {
    const p = progressOf([
      task({ id: 'third', sortOrder: 3 }),
      task({ id: 'first', sortOrder: 1 }),
      task({ id: 'second', sortOrder: 2 }),
    ]);
    expect(p.remaining.map((t) => t.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('toggleTask', () => {
  test('ticking stamps the time', () => {
    const [t] = toggleTask([task()], 't1', NOW);
    expect(t!.completedAt).toBe(NOW);
  });

  test('tapping again un-ticks — a mis-tap is recoverable', () => {
    const [t] = toggleTask([task({ completedAt: NOW })], 't1', NOW);
    expect(t!.completedAt).toBeNull();
  });

  test('other tasks are untouched', () => {
    const out = toggleTask([task({ id: 'a' }), task({ id: 'b' })], 'a', NOW);
    expect(out.find((t) => t.id === 'b')!.completedAt).toBeNull();
  });

  /** Immutability is what lets an optimistic flip roll back cleanly. */
  test('the original array is not mutated', () => {
    const original = [task()];
    toggleTask(original, 't1', NOW);
    expect(original[0]!.completedAt).toBeNull();
  });

  test('an unknown id changes nothing', () => {
    const original = [task()];
    expect(toggleTask(original, 'nope', NOW)).toEqual(original);
  });
});

describe('checkoutWarning', () => {
  test('nothing to say when everything is ticked', () => {
    expect(checkoutWarning([task({ completedAt: NOW })])).toBeNull();
  });

  test('nothing to say when there were no tasks', () => {
    expect(checkoutWarning([])).toBeNull();
  });

  test('one outstanding task is named, so the carer knows which', () => {
    const w = checkoutWarning([task({ label: 'Prompt morning medication' })]);
    expect(w).toContain('Prompt morning medication');
  });

  test('several outstanding tasks are counted', () => {
    const w = checkoutWarning([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c', completedAt: NOW })]);
    expect(w).toContain('2 of 3');
  });

  /**
   * A client who declined their shower leaves a task legitimately undone. An
   * app that blocked check-out would force the carer to tick a lie, and the
   * record should say what happened, not what the rota hoped.
   */
  test('it asks, it never forbids', () => {
    const w = checkoutWarning([task()])!;
    expect(w).toMatch(/anyway\?$/);
    expect(w).not.toMatch(/cannot|must|not allowed|required/i);
  });
});

describe('progressLabel', () => {
  test('reads naturally mid-visit', () => {
    expect(progressLabel([task({ id: 'a', completedAt: NOW }), task({ id: 'b' })])).toBe(
      '1 of 2 done',
    );
  });

  test('says so plainly when the care plan has no tasks', () => {
    expect(progressLabel([])).toBe('No tasks on the care plan');
  });
});

describe('orderForDisplay', () => {
  /**
   * A carer glancing mid-visit wants what is LEFT, not a static list to
   * re-scan. Completed items stay visible as evidence but sink.
   */
  test('outstanding tasks float above completed ones', () => {
    const out = orderForDisplay([
      task({ id: 'done1', sortOrder: 1, completedAt: NOW }),
      task({ id: 'todo', sortOrder: 2 }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['todo', 'done1']);
  });

  test('outstanding keeps care-plan order', () => {
    const out = orderForDisplay([task({ id: 'b', sortOrder: 2 }), task({ id: 'a', sortOrder: 1 })]);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });

  test('completed sit in the order they were ticked', () => {
    const out = orderForDisplay([
      task({ id: 'second', sortOrder: 1, completedAt: NOW + 100 }),
      task({ id: 'first', sortOrder: 2, completedAt: NOW }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['first', 'second']);
  });

  test('nothing is lost in the reordering', () => {
    const tasks = [
      task({ id: 'a' }),
      task({ id: 'b', completedAt: NOW }),
      task({ id: 'c' }),
    ];
    expect(orderForDisplay(tasks)).toHaveLength(3);
  });
});
