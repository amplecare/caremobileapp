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
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  deriveFlags,
  needsImmediateCall,
  orderedCategories,
  validateIncident,
  type IncidentCategory,
} from '../../lib/incidents/incident';
import { colors, font, radius, touch, type } from '../../theme/tokens';

/**
 * Incident report.
 *
 * Written to be completable one-handed, standing in someone's hallway, by a
 * carer who has just found them on the floor and is not calm. So: category
 * first as big tap targets, then two questions in plain English, and nothing
 * else on screen.
 *
 * The consequence of the chosen category is shown before submitting, never
 * after. A carer should know that picking "suspected abuse" raises a
 * safeguarding alert to their manager — hiding that would be a nasty surprise
 * and would make people pick the softer option to avoid a process they did
 * not understand.
 */
export default function IncidentScreen() {
  const { visitId, clientName, serviceUserId } = useLocalSearchParams<{
    visitId: string;
    clientName?: string;
    serviceUserId?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [category, setCategory] = useState<IncidentCategory | null>(null);
  const [description, setDescription] = useState('');
  const [immediateAction, setImmediateAction] = useState('');
  const [alsoSafeguarding, setAlsoSafeguarding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);

  const flags = useMemo(
    () => (category ? deriveFlags(category, alsoSafeguarding) : null),
    [category, alsoSafeguarding],
  );

  const submit = useCallback(async () => {
    const draft = { category, description, immediateAction, carerFlaggedSafeguarding: alsoSafeguarding };
    const check = validateIncident(draft);
    if (!check.valid) {
      setErrors(check.errors as Record<string, string>);
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      await enqueue('incident.create', `visit-${visitId}`, {
        serviceUserId: serviceUserId ?? null,
        category,
        description: description.trim(),
        immediateAction: immediateAction.trim() || null,
        isSafeguarding: flags?.isSafeguarding ?? false,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.back();
    } catch {
      setSubmitting(false);
      setFailed('That did not save. Your report is still here — try again.');
    }
  }, [category, description, immediateAction, alsoSafeguarding, flags, serviceUserId, visitId, router]);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Report an incident</Text>
        {clientName && <Text style={styles.subtitle}>{clientName}</Text>}
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 120 }}
      >
        <Text style={styles.question}>What happened?</Text>
        {errors.category && <Text style={styles.error}>{errors.category}</Text>}

        {orderedCategories().map((c) => {
          const selected = category === c;
          return (
            <Pressable
              key={c}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${CATEGORY_LABELS[c]}. ${CATEGORY_HINTS[c]}`}
              onPress={() => {
                setCategory(c);
                Haptics.selectionAsync().catch(() => {});
              }}
              style={[styles.category, selected && styles.categorySelected]}
            >
              <View style={[styles.radio, selected && styles.radioOn]} />
              <View style={styles.categoryText}>
                <Text style={[styles.categoryLabel, selected && { color: colors.nowDeep }]}>
                  {CATEGORY_LABELS[c]}
                </Text>
                <Text style={styles.categoryHint}>{CATEGORY_HINTS[c]}</Text>
              </View>
            </Pressable>
          );
        })}

        {/* The consequence, shown before submitting rather than after. */}
        {flags?.explanation && (
          <View
            style={[
              styles.consequence,
              flags.isSafeguarding && { borderColor: colors.alert, backgroundColor: colors.alertWash },
            ]}
          >
            <Text
              style={[
                styles.consequenceText,
                flags.isSafeguarding && { color: colors.alert },
              ]}
            >
              {flags.explanation}
            </Text>
            {needsImmediateCall(flags) && (
              <Text style={styles.callNote}>
                Please also ring the office now — do not wait for this to send.
              </Text>
            )}
          </View>
        )}

        <Text style={styles.question}>Describe what happened</Text>
        {errors.description && <Text style={styles.error}>{errors.description}</Text>}
        <TextInput
          value={description}
          onChangeText={setDescription}
          multiline
          textAlignVertical="top"
          placeholder="What you saw, what you were told, and when."
          placeholderTextColor={colors.inkFaint}
          accessibilityLabel="Description of the incident"
          style={styles.input}
        />

        <Text style={styles.question}>What did you do at the time?</Text>
        {errors.immediateAction && <Text style={styles.error}>{errors.immediateAction}</Text>}
        <TextInput
          value={immediateAction}
          onChangeText={setImmediateAction}
          multiline
          textAlignVertical="top"
          placeholder="Who you called, what care you gave, whether they were left safe."
          placeholderTextColor={colors.inkFaint}
          accessibilityLabel="Immediate action taken"
          style={styles.input}
        />

        {/* Can only ever escalate — the category's own flag cannot be removed. */}
        {flags && !deriveFlags(category!).isSafeguarding && (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: alsoSafeguarding }}
            onPress={() => setAlsoSafeguarding((v) => !v)}
            style={styles.safeguardRow}
          >
            <View style={[styles.checkbox, alsoSafeguarding && styles.checkboxOn]}>
              {alsoSafeguarding && <Text style={styles.tick}>✓</Text>}
            </View>
            <Text style={styles.safeguardLabel}>
              I think this is a safeguarding concern
            </Text>
          </Pressable>
        )}

        {failed && <Text style={styles.error}>{failed}</Text>}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send incident report"
          disabled={submitting}
          onPress={() => void submit()}
          style={({ pressed }) => [
            styles.submit,
            { backgroundColor: pressed ? colors.nowDeep : colors.now },
            submitting && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.submitLabel}>
            {submitting ? 'Sending…' : 'Send report'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
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

  question: {
    marginTop: 20,
    marginBottom: 8,
    fontFamily: font.semibold,
    fontSize: type.body,
    color: colors.ink,
  },

  category: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: touch.tapLg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  categorySelected: { borderColor: colors.now, backgroundColor: colors.nowWash },
  radio: {
    height: 20,
    width: 20,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.lineStrong,
  },
  radioOn: { borderColor: colors.now, backgroundColor: colors.now },
  categoryText: { flex: 1 },
  categoryLabel: { fontFamily: font.semibold, fontSize: type.body, color: colors.ink },
  categoryHint: { marginTop: 1, fontFamily: font.regular, fontSize: type.micro, color: colors.inkFaint },

  consequence: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: colors.now,
    backgroundColor: colors.nowWash,
    borderRadius: radius.card,
    padding: 14,
  },
  consequenceText: { fontFamily: font.medium, fontSize: type.small, color: colors.nowDeep, lineHeight: 21 },
  callNote: { marginTop: 8, fontFamily: font.bold, fontSize: type.small, color: colors.alert },

  input: {
    minHeight: 110,
    fontFamily: font.regular,
    fontSize: type.body,
    lineHeight: 25,
    color: colors.ink,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    padding: 14,
  },

  safeguardRow: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: touch.tapLg,
  },
  checkbox: {
    height: 26,
    width: 26,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { borderColor: colors.alert, backgroundColor: colors.alert },
  tick: { color: '#FFFFFF', fontFamily: font.bold, fontSize: type.small },
  safeguardLabel: { flex: 1, fontFamily: font.medium, fontSize: type.body, color: colors.ink },

  error: { marginBottom: 6, fontFamily: font.medium, fontSize: type.small, color: colors.alert },

  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  submit: {
    height: touch.action,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitLabel: { fontFamily: font.bold, fontSize: type.title, color: '#FFFFFF' },
});
