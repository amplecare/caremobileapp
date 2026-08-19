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
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { enqueue } from '../lib/outbox/store';
import {
  ABSENCE_REASONS,
  DAYS,
  DAY_LABELS,
  absenceDays,
  formatClaim,
  mileageAmount,
  summariseAvailability,
  validateAbsence,
  validateMileage,
  validateWindow,
  type AbsenceReason,
  type AvailabilityWindow,
  type Day,
} from '../lib/hr/availability';
import { bandPresentation, expiryBand, expiryPhrase } from '../lib/hr/expiry';
import { colors, font, radius, touch, type } from '../theme/tokens';

/**
 * Me — the carer's own record.
 *
 * Three jobs a carer does between visits, on a phone, in a car: tell the
 * office when they can work, tell them when they cannot, and claim their
 * mileage before they forget.
 *
 * Their own compliance sits at the top, because a carer whose DBS lapses
 * stops being able to work and nobody currently tells them until it is too
 * late. Seeing their own expiry dates is the single most useful thing this
 * screen does.
 */

/** Placeholder until the profile syncs. */
const COMPLIANCE = [
  { label: 'DBS certificate', expiry: '2026-11-02' },
  { label: 'Right to work', expiry: null },
  { label: 'Moving & handling', expiry: '2026-09-04' },
  { label: 'Safeguarding training', expiry: '2027-03-15' },
];

const INITIAL_AVAILABILITY: AvailabilityWindow[] = [
  { id: 'a1', day: 'monday', start: '07:00', end: '14:00' },
  { id: 'a2', day: 'tuesday', start: '07:00', end: '14:00' },
  { id: 'a3', day: 'wednesday', start: '07:00', end: '14:00' },
];

type Panel = 'none' | 'absence' | 'mileage' | 'availability';

export default function MeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>('none');
  const [availability] = useState(INITIAL_AVAILABILITY);
  const [banner, setBanner] = useState<string | null>(null);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Me</Text>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
      >
        {banner && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{banner}</Text>
          </View>
        )}

        {/* Compliance first — nobody tells a carer their DBS is lapsing. */}
        <Text style={styles.sectionLabel}>MY DOCUMENTS</Text>
        {COMPLIANCE.map((doc) => {
          const band = expiryBand(doc.expiry);
          const p = bandPresentation(band);
          return (
            <View key={doc.label} style={styles.docRow}>
              <View style={[styles.dot, { backgroundColor: p.dot }]} />
              <View style={styles.docText}>
                <Text style={styles.docLabel}>{doc.label}</Text>
                <Text style={styles.docExpiry}>{expiryPhrase(doc.expiry)}</Text>
              </View>
              <Text style={[styles.docBadge, { color: p.dot }]}>{p.short}</Text>
            </View>
          );
        })}

        <Text style={styles.sectionLabel}>MY WEEK</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{summariseAvailability(availability)}</Text>
          {DAYS.filter((d) => availability.some((w) => w.day === d)).map((d) => (
            <Text key={d} style={styles.availLine}>
              {DAY_LABELS[d]}
              {'  '}
              {availability
                .filter((w) => w.day === d)
                .map((w) => `${w.start}–${w.end}`)
                .join(', ')}
            </Text>
          ))}
        </View>

        <Action label="Tell the office I'm unavailable" onPress={() => setPanel('absence')} />
        <Action label="Claim mileage" onPress={() => setPanel('mileage')} />

        {panel === 'absence' && (
          <AbsencePanel
            onClose={() => setPanel('none')}
            onDone={(msg) => {
              setPanel('none');
              setBanner(msg);
            }}
          />
        )}

        {panel === 'mileage' && (
          <MileagePanel
            onClose={() => setPanel('none')}
            onDone={(msg) => {
              setPanel('none');
              setBanner(msg);
            }}
          />
        )}

        <Text style={styles.footnote}>
          Anything you send here queues on your phone and reaches the office as
          soon as you have signal.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && { backgroundColor: colors.surfaceSunk }]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

/** Absence request. Short notice warns but never blocks. */
function AbsencePanel({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState<AbsenceReason>('sickness');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const s = new Date(start);
    const e = new Date(end);
    const check = validateAbsence(reason, s, e);
    if (!check.valid) {
      setError(check.error);
      return;
    }
    setError(null);
    setWarning(check.warning);
    setBusy(true);

    try {
      await enqueue('availability.update', 'me', {
        kind: 'unavailability',
        reason,
        startDatetime: s.toISOString(),
        endDatetime: e.toISOString(),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onDone(`Sent — ${absenceDays(s, e)} day${absenceDays(s, e) === 1 ? '' : 's'} off requested.`);
    } catch {
      setBusy(false);
      setError('That did not send. Try again.');
    }
  }, [reason, start, end, onDone]);

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Time off</Text>

      <View style={styles.reasonRow}>
        {ABSENCE_REASONS.map((r) => (
          <Pressable
            key={r.code}
            accessibilityRole="radio"
            accessibilityState={{ selected: reason === r.code }}
            onPress={() => setReason(r.code)}
            style={[styles.chip, reason === r.code && styles.chipOn]}
          >
            <Text style={[styles.chipText, reason === r.code && { color: '#FFFFFF' }]}>
              {r.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        value={start}
        onChangeText={setStart}
        placeholder="From — YYYY-MM-DD"
        placeholderTextColor={colors.inkFaint}
        accessibilityLabel="Absence start date"
        style={styles.input}
      />
      <TextInput
        value={end}
        onChangeText={setEnd}
        placeholder="To — YYYY-MM-DD"
        placeholderTextColor={colors.inkFaint}
        accessibilityLabel="Absence end date"
        style={styles.input}
      />

      {error && <Text style={styles.error}>{error}</Text>}
      {warning && <Text style={styles.warning}>{warning}</Text>}

      <PanelActions busy={busy} onCancel={onClose} onSubmit={() => void submit()} label="Send request" />
    </View>
  );
}

/** Mileage claim, priced at HMRC rates as the carer types. */
function MileagePanel({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [milesText, setMilesText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const miles = Number(milesText);
  const preview = useMemo(
    () => (Number.isFinite(miles) && miles > 0 ? formatClaim(miles) : null),
    [miles],
  );

  const submit = useCallback(async () => {
    const check = validateMileage(miles);
    if (!check.valid) {
      setError(check.error);
      return;
    }
    setError(null);
    setBusy(true);

    try {
      await enqueue('availability.update', 'me', {
        kind: 'mileage',
        miles,
        amount: mileageAmount(miles),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onDone(`Mileage claim sent — ${formatClaim(miles)}.`);
    } catch {
      setBusy(false);
      setError('That did not send. Try again.');
    }
  }, [miles, onDone]);

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Mileage</Text>
      <TextInput
        value={milesText}
        onChangeText={setMilesText}
        keyboardType="decimal-pad"
        placeholder="Miles driven"
        placeholderTextColor={colors.inkFaint}
        accessibilityLabel="Miles driven"
        style={styles.input}
      />
      {/* Priced as they type — no surprises at payroll. */}
      {preview && <Text style={styles.preview}>{preview}</Text>}
      <Text style={styles.rateNote}>Paid at the HMRC rate of 45p a mile.</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <PanelActions busy={busy} onCancel={onClose} onSubmit={() => void submit()} label="Send claim" />
    </View>
  );
}

function PanelActions({
  busy,
  onCancel,
  onSubmit,
  label,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  label: string;
}) {
  return (
    <View style={styles.panelActions}>
      <Pressable onPress={onCancel} style={styles.cancel}>
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onSubmit}
        style={({ pressed }) => [
          styles.submit,
          { backgroundColor: pressed ? colors.nowDeep : colors.now },
          busy && { opacity: 0.4 },
        ]}
      >
        <Text style={styles.submitText}>{busy ? 'Sending…' : label}</Text>
      </Pressable>
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

  banner: {
    padding: 14,
    borderRadius: radius.card,
    backgroundColor: colors.doneWash,
    borderWidth: 1,
    borderColor: colors.done,
    marginBottom: 16,
  },
  bannerText: { fontFamily: font.medium, fontSize: type.small, color: colors.done },

  sectionLabel: {
    marginTop: 8,
    marginBottom: 10,
    fontFamily: font.monoBold,
    fontSize: type.micro,
    letterSpacing: 1.2,
    color: colors.inkFaint,
  },

  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: touch.tapLg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    marginBottom: 8,
  },
  dot: { height: 10, width: 10, borderRadius: radius.pill },
  docText: { flex: 1 },
  docLabel: { fontFamily: font.semibold, fontSize: type.body, color: colors.ink },
  docExpiry: { marginTop: 1, fontFamily: font.regular, fontSize: type.micro, color: colors.inkFaint },
  docBadge: { fontFamily: font.monoBold, fontSize: type.micro },

  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    padding: 16,
  },
  cardTitle: { fontFamily: font.semibold, fontSize: type.body, color: colors.ink, marginBottom: 8 },
  availLine: { fontFamily: font.mono, fontSize: type.small, color: colors.inkSoft, lineHeight: 22 },

  action: {
    marginTop: 12,
    minHeight: touch.tapLg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { fontFamily: font.semibold, fontSize: type.body, color: colors.ink },

  panel: {
    marginTop: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.now,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
  },
  panelTitle: { fontFamily: font.bold, fontSize: type.body, color: colors.ink, marginBottom: 12 },

  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: {
    minHeight: touch.tap,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  chipOn: { backgroundColor: colors.now, borderColor: colors.now },
  chipText: { fontFamily: font.medium, fontSize: type.small, color: colors.ink },

  input: {
    minHeight: touch.tapLg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    paddingHorizontal: 14,
    marginBottom: 8,
    fontFamily: font.regular,
    fontSize: type.body,
    color: colors.ink,
    backgroundColor: colors.paper,
  },
  preview: { fontFamily: font.bold, fontSize: type.title, color: colors.now, marginTop: 4 },
  rateNote: { marginTop: 4, fontFamily: font.regular, fontSize: type.micro, color: colors.inkFaint },

  error: { marginTop: 8, fontFamily: font.medium, fontSize: type.small, color: colors.alert },
  warning: { marginTop: 8, fontFamily: font.medium, fontSize: type.small, color: colors.live },

  panelActions: { flexDirection: 'row', gap: 8, marginTop: 14 },
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
  submit: {
    flex: 1,
    minHeight: touch.tapLg,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { fontFamily: font.bold, fontSize: type.body, color: '#FFFFFF' },

  footnote: {
    marginTop: 24,
    fontFamily: font.regular,
    fontSize: type.micro,
    lineHeight: 18,
    color: colors.inkFaint,
  },
});
