import { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { enqueue } from '../../lib/outbox/store';
import {
  OUTCOME_LABELS,
  confirmationPrompt,
  doseTiming,
  needsSecondConfirmation,
  roundSummary,
  safetyNotes,
  validateAdministration,
  type Medication,
  type Outcome,
} from '../../lib/emar/administration';
import { colors, font, radius, touch, type } from '../../theme/tokens';

/**
 * MAR chart for one visit.
 *
 * Deliberately the slowest screen in the app. One medication per card, three
 * explicit outcomes, and no swipe gestures anywhere — swipes are for email,
 * not for recording that someone took morphine. A mis-swipe here is a
 * falsified clinical record.
 *
 * Each card is recorded independently and queued as it is confirmed, so a
 * carer interrupted half-way through a round has the first two doses safely
 * recorded rather than losing the lot.
 */

/** Placeholder round until visits carry their medications from the server. */
const ROUND: Medication[] = [
  {
    id: 'med-1',
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
    withFood: true,
    specialInstructions: null,
  },
  {
    id: 'med-2',
    name: 'Warfarin',
    dose: '3mg',
    route: 'Oral',
    isPrn: false,
    isControlledDrug: false,
    isHighRisk: true,
    isCovert: false,
    covertInstructions: null,
    storageInstructions: null,
    scheduledTime: '08:00',
    withFood: false,
    specialInstructions: 'Check the dose against the yellow book.',
  },
  {
    id: 'med-3',
    name: 'Paracetamol',
    dose: '500mg — up to 2 tablets',
    route: 'Oral',
    isPrn: true,
    isControlledDrug: false,
    isHighRisk: false,
    isCovert: false,
    covertInstructions: null,
    storageInstructions: null,
    scheduledTime: null,
    withFood: false,
    specialInstructions: 'Maximum 8 tablets in 24 hours.',
  },
];

type Recorded = Record<string, Outcome>;

export default function EmarScreen() {
  const { visitId, clientName } = useLocalSearchParams<{
    visitId: string;
    clientName?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [recorded, setRecorded] = useState<Recorded>({});
  const [error, setError] = useState<string | null>(null);

  const scheduled = useMemo(() => ROUND.filter((m) => !m.isPrn), []);
  const prn = useMemo(() => ROUND.filter((m) => m.isPrn), []);

  const summary = roundSummary(
    scheduled.map((m) => ({ outcome: recorded[m.id] ?? null })),
  );

  const record = useCallback(
    async (med: Medication, outcome: Outcome, refusalReason: string, confirmed: boolean) => {
      const draft = {
        outcome,
        refusalReason,
        notes: '',
        witnessedBy: null,
        secondConfirmation: confirmed,
      };
      const check = validateAdministration(med, draft);
      if (!check.valid) {
        setError(
          check.errors.refusalReason ?? check.errors.secondConfirmation ?? 'Check that entry',
        );
        return false;
      }

      setError(null);
      setRecorded((prev) => ({ ...prev, [med.id]: outcome }));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      try {
        await enqueue('medication.record', `visit-${visitId}`, {
          medicationId: med.id,
          visitId,
          outcome,
          at: new Date().toISOString(),
          scheduledTime: med.scheduledTime,
          refusalReason: refusalReason.trim() || null,
        });
        return true;
      } catch {
        setRecorded((prev) => {
          const next = { ...prev };
          delete next[med.id];
          return next;
        });
        setError('That did not save. Please record it again.');
        return false;
      }
    },
    [visitId],
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Medication</Text>
        <Text style={styles.subtitle}>
          {clientName ? `${clientName} · ` : ''}
          {summary}
        </Text>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
      >
        {error && (
          <Text role="alert" style={styles.error}>
            {error}
          </Text>
        )}

        {scheduled.map((m) => (
          <MedicationCard
            key={m.id}
            med={m}
            outcome={recorded[m.id] ?? null}
            onRecord={record}
          />
        ))}

        {prn.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>WHEN NEEDED</Text>
            {prn.map((m) => (
              <MedicationCard
                key={m.id}
                med={m}
                outcome={recorded[m.id] ?? null}
                onRecord={record}
              />
            ))}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * One medication. Never a list row — a card, with the whole decision visible
 * at once, because a carer scrolling a dense list is how the wrong box gets
 * ticked.
 */
function MedicationCard({
  med,
  outcome,
  onRecord,
}: {
  med: Medication;
  outcome: Outcome | null;
  onRecord: (
    med: Medication,
    outcome: Outcome,
    refusalReason: string,
    confirmed: boolean,
  ) => Promise<boolean>;
}) {
  const [pending, setPending] = useState<Outcome | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const timing = doseTiming(med);
  const notes = safetyNotes(med);
  const prompt = confirmationPrompt(med);
  const done = outcome !== null;

  const choose = async (o: Outcome) => {
    Haptics.selectionAsync().catch(() => {});
    // Refusals and risky administrations open an extra step rather than
    // recording straight away.
    if (o === 'refused' || needsSecondConfirmation(med, o)) {
      setPending(o);
      return;
    }
    await onRecord(med, o, '', false);
  };

  const commit = async () => {
    if (!pending) return;
    const ok = await onRecord(med, pending, reason, confirmed);
    if (ok) {
      setPending(null);
      setReason('');
      setConfirmed(false);
    }
  };

  return (
    <View style={[styles.card, done && styles.cardDone]}>
      <View style={styles.cardTop}>
        <View style={styles.cardHeading}>
          <Text style={styles.medName}>{med.name}</Text>
          <Text style={styles.medDose}>
            {[med.dose, med.route].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Text
          style={[
            styles.timing,
            timing === 'missed' && { color: colors.alert },
            timing === 'late' && { color: colors.live },
          ]}
        >
          {med.isPrn ? 'As needed' : `${med.scheduledTime} · ${timing}`}
        </Text>
      </View>

      {notes.length > 0 && (
        <View style={styles.notes}>
          {notes.map((n) => (
            <Text key={n} style={styles.note}>
              • {n}
            </Text>
          ))}
        </View>
      )}

      {done ? (
        <View style={styles.recorded}>
          <Text style={styles.recordedText}>Recorded: {OUTCOME_LABELS[outcome]}</Text>
        </View>
      ) : pending ? (
        <View style={styles.pending}>
          {pending === 'refused' && (
            <>
              <Text style={styles.pendingLabel}>Why was it refused?</Text>
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder="e.g. said she felt sick"
                placeholderTextColor={colors.inkFaint}
                accessibilityLabel={`Reason ${med.name} was refused`}
                style={styles.reasonInput}
              />
            </>
          )}

          {prompt && needsSecondConfirmation(med, pending) && (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: confirmed }}
              onPress={() => setConfirmed((v) => !v)}
              style={styles.confirmRow}
            >
              <View style={[styles.checkbox, confirmed && styles.checkboxOn]}>
                {confirmed && <Text style={styles.tick}>✓</Text>}
              </View>
              <Text style={styles.confirmText}>{prompt}</Text>
            </Pressable>
          )}

          <View style={styles.pendingActions}>
            <Pressable onPress={() => setPending(null)} style={styles.cancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Confirm ${OUTCOME_LABELS[pending]} for ${med.name}`}
              onPress={() => void commit()}
              style={({ pressed }) => [
                styles.commit,
                { backgroundColor: pressed ? colors.nowDeep : colors.now },
              ]}
            >
              <Text style={styles.commitText}>Confirm {OUTCOME_LABELS[pending]}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        // Three explicit outcomes. No swipes anywhere on this screen.
        <View style={styles.outcomes}>
          {(['administered', 'refused', 'not_required'] as Outcome[]).map((o) => (
            <Pressable
              key={o}
              accessibilityRole="button"
              accessibilityLabel={`${OUTCOME_LABELS[o]} — ${med.name}`}
              onPress={() => void choose(o)}
              style={({ pressed }) => [
                styles.outcome,
                o === 'administered' && styles.outcomeGiven,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text
                style={[styles.outcomeText, o === 'administered' && { color: '#FFFFFF' }]}
              >
                {OUTCOME_LABELS[o]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  back: { alignSelf: 'flex-start', minHeight: touch.tap, justifyContent: 'center' },
  backText: { fontFamily: font.semibold, fontSize: type.body, color: colors.now },
  title: { fontFamily: font.bold, fontSize: type.title, color: colors.ink },
  subtitle: { marginTop: 2, fontFamily: font.regular, fontSize: type.small, color: colors.inkSoft },

  sectionLabel: {
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
    fontFamily: font.monoBold,
    fontSize: type.micro,
    letterSpacing: 1.2,
    color: colors.inkFaint,
  },

  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    padding: 16,
    marginBottom: 12,
  },
  cardDone: { borderColor: colors.done, backgroundColor: colors.doneWash },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  cardHeading: { flex: 1 },
  medName: { fontFamily: font.bold, fontSize: type.title, color: colors.ink },
  medDose: { marginTop: 2, fontFamily: font.medium, fontSize: type.small, color: colors.inkSoft },
  timing: { fontFamily: font.mono, fontSize: type.micro, color: colors.inkFaint },

  notes: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.surfaceSunk,
  },
  note: { fontFamily: font.medium, fontSize: type.small, color: colors.ink, lineHeight: 21 },

  outcomes: { flexDirection: 'row', gap: 8, marginTop: 14 },
  outcome: {
    flex: 1,
    minHeight: touch.tapLg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  outcomeGiven: { backgroundColor: colors.now, borderColor: colors.now },
  outcomeText: {
    fontFamily: font.semibold,
    fontSize: type.small,
    color: colors.ink,
    textAlign: 'center',
  },

  pending: { marginTop: 14 },
  pendingLabel: { fontFamily: font.semibold, fontSize: type.small, color: colors.ink, marginBottom: 6 },
  reasonInput: {
    minHeight: touch.tapLg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    paddingHorizontal: 14,
    fontFamily: font.regular,
    fontSize: type.body,
    color: colors.ink,
    backgroundColor: colors.paper,
  },
  confirmRow: { flexDirection: 'row', gap: 12, marginTop: 12, alignItems: 'flex-start' },
  checkbox: {
    height: 26,
    width: 26,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { borderColor: colors.now, backgroundColor: colors.now },
  tick: { color: '#FFFFFF', fontFamily: font.bold, fontSize: type.small },
  confirmText: { flex: 1, fontFamily: font.medium, fontSize: type.small, color: colors.ink, lineHeight: 21 },

  pendingActions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  cancel: {
    minHeight: touch.tapLg,
    paddingHorizontal: 18,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { fontFamily: font.semibold, fontSize: type.small, color: colors.inkSoft },
  commit: {
    flex: 1,
    minHeight: touch.tapLg,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commitText: { fontFamily: font.bold, fontSize: type.body, color: '#FFFFFF' },

  recorded: {
    marginTop: 14,
    minHeight: touch.tap,
    justifyContent: 'center',
  },
  recordedText: { fontFamily: font.semibold, fontSize: type.body, color: colors.done },

  error: {
    marginBottom: 12,
    padding: 12,
    borderRadius: radius.card,
    backgroundColor: colors.alertWash,
    fontFamily: font.medium,
    fontSize: type.small,
    color: colors.alert,
  },
});
