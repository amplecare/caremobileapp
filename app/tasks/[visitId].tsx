import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { enqueue, getTasks, putTasks, setTaskCompleted } from '../../lib/outbox/store';
import {
  orderForDisplay,
  progressLabel,
  progressOf,
  toggleTask,
  type VisitTask,
} from '../../lib/tasks/checklist';
import { colors, font, radius, touch, type } from '../../theme/tokens';

/**
 * Visit task checklist.
 *
 * The tick is the evidence that commissioned care was delivered, so the
 * interaction is built around being wrong-proof rather than fast: 56pt rows,
 * tap anywhere, a haptic on each change, and tapping again un-ticks. A carer
 * with wet hands after personal care will mis-tap, and recovering must be as
 * easy as the mistake.
 *
 * Every tick writes to SQLite and queues immediately. Nothing here waits on a
 * network call — a carer in a basement flat ticks boxes exactly as fast as
 * one standing in the street.
 */

/**
 * Placeholder care plan until visits sync from the server. Seeded on first
 * open so the persistence path is exercised for real rather than mocked with
 * component state.
 */
const DEFAULT_PLAN = [
  { id: 'personal-care', label: 'Assist with personal care', sortOrder: 1 },
  { id: 'medication', label: 'Prompt morning medication', sortOrder: 2 },
  { id: 'breakfast', label: 'Prepare breakfast and a hot drink', sortOrder: 3 },
  { id: 'mobility', label: 'Support with mobility around the home', sortOrder: 4 },
  { id: 'tidy', label: 'Tidy kitchen and empty bins', sortOrder: 5 },
];

export default function TasksScreen() {
  const { visitId, clientName } = useLocalSearchParams<{
    visitId: string;
    clientName?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [tasks, setTasks] = useState<VisitTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let rows = await getTasks(visitId);
        if (rows.length === 0) {
          await putTasks(visitId, DEFAULT_PLAN);
          rows = await getTasks(visitId);
        }
        if (!cancelled) setTasks(rows);
      } catch {
        if (!cancelled) setError('Could not load the checklist for this visit.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId]);

  const onToggle = useCallback(
    async (taskId: string) => {
      const previous = tasks;
      const next = toggleTask(tasks, taskId);
      const changed = next.find((t) => t.id === taskId)!;

      // Optimistic: the tick lands under the carer's thumb immediately.
      setTasks(next);
      Haptics.selectionAsync().catch(() => {});

      try {
        await setTaskCompleted(taskId, changed.completedAt);
        await enqueue('visit.task_toggle', `visit-${visitId}`, {
          visitId,
          taskId,
          completed: changed.completedAt !== null,
          at: new Date(changed.completedAt ?? Date.now()).toISOString(),
        });
      } catch {
        // Roll back rather than show a tick that was never recorded.
        setTasks(previous);
        setError('That did not save. Tap it again.');
      }
    },
    [tasks, visitId],
  );

  const progress = progressOf(tasks);
  const ordered = orderForDisplay(tasks);

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {clientName ?? 'Visit'} tasks
        </Text>

        <View style={styles.progressRow}>
          <Text style={styles.progressLabel}>{progressLabel(tasks)}</Text>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                {
                  width: `${progress.percent}%`,
                  backgroundColor: progress.complete ? colors.done : colors.now,
                },
              ]}
            />
          </View>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        {loading ? (
          <ActivityIndicator style={styles.loading} color={colors.inkSoft} />
        ) : (
          ordered.map((t) => {
            const done = t.completedAt !== null;
            return (
              <Pressable
                key={t.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: done }}
                accessibilityLabel={t.label}
                onPress={() => void onToggle(t.id)}
                style={({ pressed }) => [
                  styles.row,
                  pressed && { backgroundColor: colors.surfaceSunk },
                ]}
              >
                <View style={[styles.box, done && styles.boxDone]}>
                  {done && <Text style={styles.tick}>✓</Text>}
                </View>
                <Text style={[styles.label, done && styles.labelDone]}>{t.label}</Text>
              </Pressable>
            );
          })
        )}

        {!loading && tasks.length === 0 && (
          <Text style={styles.empty}>No tasks on the care plan for this visit.</Text>
        )}

        {error && (
          <Text role="alert" style={styles.error}>
            {error}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },

  header: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  back: {
    alignSelf: 'flex-start',
    minHeight: touch.tap,
    justifyContent: 'center',
  },
  backText: { fontFamily: font.semibold, fontSize: type.body, color: colors.now },
  title: { fontFamily: font.bold, fontSize: type.title, color: colors.ink },

  progressRow: { marginTop: 10 },
  progressLabel: {
    fontFamily: font.mono,
    fontSize: type.micro,
    color: colors.inkFaint,
    marginBottom: 6,
  },
  track: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSunk,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill },

  loading: { marginTop: 40 },

  row: {
    minHeight: touch.tapLg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  box: {
    height: 26,
    width: 26,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxDone: { borderColor: colors.done, backgroundColor: colors.done },
  tick: { color: '#FFFFFF', fontFamily: font.bold, fontSize: type.small },

  label: { flex: 1, fontFamily: font.medium, fontSize: type.body, color: colors.ink },
  labelDone: { color: colors.inkFaint, textDecorationLine: 'line-through' },

  empty: {
    marginTop: 40,
    textAlign: 'center',
    fontFamily: font.regular,
    fontSize: type.body,
    color: colors.inkSoft,
  },
  error: {
    marginTop: 16,
    paddingHorizontal: 20,
    fontFamily: font.medium,
    fontSize: type.small,
    color: colors.alert,
  },
});
