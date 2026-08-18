import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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

import { clearDraft, enqueue, getDraft, saveDraft } from '../../lib/outbox/store';
import {
  charsRemaining,
  concernPrompt,
  detectConcerns,
  shouldShowCounter,
  validateNote,
} from '../../lib/notes/note';
import { colors, font, radius, touch, type } from '../../theme/tokens';

/**
 * Care note editor.
 *
 * Two rules from the plan meet here.
 *
 * "Never lose a word": every keystroke writes to SQLite. No debounce, no
 * save button standing between the carer and their work. A flat battery
 * mid-sentence costs nothing. The draft is cleared ONLY after the note is
 * safely in the outbox — never on navigating away.
 *
 * "It prompts, it never gates": if the text mentions a fall or a
 * safeguarding concern, we ask about an incident report before saving. The
 * carer can decline and the note saves regardless. They were there; we were
 * not.
 */
export default function NoteScreen() {
  const { visitId, clientName } = useLocalSearchParams<{
    visitId: string;
    clientName?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  // Restore whatever was half-written last time — the whole point of drafts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await getDraft(visitId);
        if (!cancelled && existing) setText(existing);
      } catch {
        // A missing draft is normal; a broken read should not block writing
        // a new note.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId]);

  /**
   * Autosave on every keystroke, deliberately unthrottled. SQLite handles
   * thousands of small writes a second; losing a carer's account of a fall
   * to a debounce timer is not a trade worth making.
   */
  const onChange = useCallback(
    (next: string) => {
      setText(next);
      if (error) setError(null);
      void saveDraft(visitId, next).catch(() => {
        // Surface it rather than let the carer believe it is safe.
        setError('Not saving to this device — copy your note somewhere safe');
      });
    },
    [visitId, error],
  );

  const submit = useCallback(
    async (skipConcernCheck = false) => {
      const check = validateNote(text);
      if (!check.valid) {
        setError(check.error);
        return;
      }

      // Ask about an incident before saving, once.
      if (!skipConcernCheck) {
        const prompt = concernPrompt(detectConcerns(check.value));
        if (prompt) {
          // Incident reporting lands in Stage 5. Until it exists there is no
          // "report it" button here, because a button that goes nowhere is
          // worse than no button — a carer would tap it, believe the incident
          // was raised, and move on. The nudge still does its job: it makes
          // them think about it while they are still with the client.
          Alert.alert(
            'Before you save',
            `${prompt}

Incident reporting is coming shortly. For now, please ring the office if this needs raising today.`,
            [
              { text: 'Go back and edit', style: 'cancel' },
              { text: 'Save the note', onPress: () => void submit(true) },
            ],
          );
          return;
        }
      }

      setSaving(true);
      try {
        await enqueue('visit.note', `visit-${visitId}`, {
          visitId,
          text: check.value,
        });
        // Only now is it safe to drop the draft.
        await clearDraft(visitId);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        router.back();
      } catch {
        setSaving(false);
        setError('Could not save that. Your note is still here — try again.');
      }
    },
    [text, visitId, router],
  );

  const remaining = charsRemaining(text);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          Note for {clientName ?? 'this visit'}
        </Text>
        <Text style={styles.subtitle}>Saved on this phone as you type</Text>
      </View>

      <ScrollView
        style={styles.body}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {loading ? (
          <ActivityIndicator style={styles.loading} color={colors.inkSoft} />
        ) : (
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={onChange}
            multiline
            autoFocus
            textAlignVertical="top"
            placeholder="How was the visit? What did you do, and how were they?"
            placeholderTextColor={colors.inkFaint}
            accessibilityLabel="Care note"
            style={styles.input}
          />
        )}

        {error && (
          <Text role="alert" style={styles.error}>
            {error}
          </Text>
        )}

        {shouldShowCounter(text) && (
          <Text style={[styles.counter, remaining < 0 && { color: colors.alert }]}>
            {remaining} characters left
          </Text>
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save note"
          disabled={saving || loading}
          onPress={() => void submit()}
          style={({ pressed }) => [
            styles.save,
            { backgroundColor: pressed ? colors.nowDeep : colors.now },
            (saving || loading) && styles.saveDisabled,
          ]}
        >
          <Text style={styles.saveLabel}>{saving ? 'Saving…' : 'Save note'}</Text>
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
  back: { alignSelf: 'flex-start', paddingVertical: 6, minHeight: touch.tap, justifyContent: 'center' },
  backText: { fontFamily: font.semibold, fontSize: type.body, color: colors.now },
  title: { fontFamily: font.bold, fontSize: type.title, color: colors.ink },
  subtitle: { marginTop: 2, fontFamily: font.regular, fontSize: type.micro, color: colors.inkFaint },

  body: { flex: 1, paddingHorizontal: 20, paddingTop: 16 },
  loading: { marginTop: 40 },
  input: {
    minHeight: 220,
    fontFamily: font.regular,
    fontSize: type.body,
    lineHeight: 25,
    color: colors.ink,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    padding: 16,
  },
  error: {
    marginTop: 10,
    fontFamily: font.medium,
    fontSize: type.small,
    color: colors.alert,
  },
  counter: {
    marginTop: 8,
    textAlign: 'right',
    fontFamily: font.mono,
    fontSize: type.micro,
    color: colors.inkFaint,
  },

  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  save: {
    height: touch.action,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveDisabled: { opacity: 0.4 },
  saveLabel: { fontFamily: font.bold, fontSize: type.title, color: '#FFFFFF' },
});
