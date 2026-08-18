/**
 * Visit task checklist.
 *
 * Tasks come from the client's care plan — "assist with personal care",
 * "prompt morning medication", "prepare breakfast". The carer ticks them off
 * as they go, and the completions become evidence that the care commissioned
 * was actually delivered.
 *
 * Pure functions only. The rules about what a checklist means — is this visit
 * finished, what is outstanding, can they check out — are decided here and
 * tested, rather than scattered through a component.
 */

export interface VisitTask {
  id: string;
  visitId: string;
  label: string;
  sortOrder: number;
  /** Epoch ms, or null if not done. */
  completedAt: number | null;
  /** Optional free text — "declined, said she'd wait for her daughter". */
  notes: string | null;
}

export interface ChecklistProgress {
  total: number;
  done: number;
  /** 0–100, rounded. Zero tasks is 0%, never NaN. */
  percent: number;
  /** Tasks still outstanding, in order. */
  remaining: VisitTask[];
  complete: boolean;
}

export function progressOf(tasks: VisitTask[]): ChecklistProgress {
  const total = tasks.length;
  const remaining = tasks
    .filter((t) => t.completedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const done = total - remaining.length;

  return {
    total,
    done,
    // Guard the divide: a visit with no tasks on the care plan is normal for
    // a welfare check, and must not render as NaN%.
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    remaining,
    complete: total > 0 && remaining.length === 0,
  };
}

/**
 * Toggles a task, returning a new array.
 *
 * Immutable so React state updates are predictable, and so an optimistic
 * flip can be rolled back by simply keeping the previous array.
 */
export function toggleTask(
  tasks: VisitTask[],
  taskId: string,
  now: number = Date.now(),
): VisitTask[] {
  return tasks.map((t) =>
    t.id === taskId ? { ...t, completedAt: t.completedAt === null ? now : null } : t,
  );
}

/**
 * What to warn about when a carer checks out with tasks outstanding.
 *
 * Returns null when there is nothing to say. Crucially this is a WARNING, not
 * a block: a client who declined their shower, or was asleep, leaves tasks
 * legitimately undone, and an app that refused check-out would force the
 * carer to tick a lie. The record should say what happened, not what the
 * rota hoped would happen.
 */
export function checkoutWarning(tasks: VisitTask[]): string | null {
  const { remaining, total } = progressOf(tasks);
  if (total === 0 || remaining.length === 0) return null;

  if (remaining.length === 1) {
    return `"${remaining[0]!.label}" is not ticked. Check out anyway?`;
  }
  return `${remaining.length} of ${total} tasks are not ticked. Check out anyway?`;
}

/** Short label for the checklist header: "3 of 5 done". */
export function progressLabel(tasks: VisitTask[]): string {
  const { total, done } = progressOf(tasks);
  if (total === 0) return 'No tasks on the care plan';
  return `${done} of ${total} done`;
}

/**
 * Orders tasks for display: outstanding first, completed sinking to the
 * bottom in the order they were ticked.
 *
 * A carer looking at their phone mid-visit wants what is left, not a static
 * list they have to re-scan. Completed items stay visible — they are the
 * evidence — but they get out of the way.
 */
export function orderForDisplay(tasks: VisitTask[]): VisitTask[] {
  const outstanding = tasks
    .filter((t) => t.completedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const completed = tasks
    .filter((t) => t.completedAt !== null)
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  return [...outstanding, ...completed];
}
