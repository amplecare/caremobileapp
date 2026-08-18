import { useCallback, useState } from 'react';
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

import { enqueue } from '../lib/outbox/store';
import { colors, font, radius, touch, type } from '../theme/tokens';

/**
 * Message the office.
 *
 * Deliberately a one-way compose screen rather than a chat thread. Two
 * reasons: a carer between visits has thirty seconds and a question, not a
 * conversation; and a reply needs realtime delivery, which is Stage 5d's
 * push work. Building a thread UI that cannot receive would look broken.
 *
 * Quick-pick prompts cover most of what carers actually send. Typing a
 * sentence one-handed on a doorstep is the thing to avoid where possible.
 */

const QUICK_MESSAGES = [
  { text: 'Running late for my next visit', urgent: false },
  { text: 'No answer at the door', urgent: true },
  { text: 'Client seems unwell — please advise', urgent: true },
  { text: 'Can someone cover my next visit?', urgent: false },
  { text: 'Key safe code is not working', urgent: true },
];

const MAX_MESSAGE = 1000;

export default function MessageScreen() {
  const { visitId, clientName } = useLocalSearchParams<{
    visitId?: string;
    clientName?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [text, setText] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async () => {
    const body = text.trim();
    if (body.length === 0) {
      setError('Write a message first');
      return;
    }
    setError(null);
    setSending(true);

    try {
      await enqueue('message.send', 'office', {
        body,
        visitId: visitId ?? undefined,
        isUrgent: urgent,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.back();
    } catch {
      setSending(false);
      setError('That did not send. Your message is still here — try again.');
    }
  }, [text, urgent, visitId, router]);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Message the office</Text>
        {clientName && <Text style={styles.subtitle}>About {clientName}</Text>}
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 120 }}
      >
        <Text style={styles.sectionLabel}>Quick messages</Text>
        {QUICK_MESSAGES.map((q) => (
          <Pressable
            key={q.text}
            accessibilityRole="button"
            accessibilityLabel={`Use message: ${q.text}`}
            onPress={() => {
              setText(q.text);
              setUrgent(q.urgent);
              Haptics.selectionAsync().catch(() => {});
            }}
            style={({ pressed }) => [styles.quick, pressed && { backgroundColor: colors.surfaceSunk }]}
          >
            <Text style={styles.quickText}>{q.text}</Text>
            {q.urgent && <Text style={styles.quickUrgent}>Urgent</Text>}
          </Pressable>
        ))}

        <Text style={styles.sectionLabel}>Or write your own</Text>
        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            if (error) setError(null);
          }}
          multiline
          maxLength={MAX_MESSAGE}
          textAlignVertical="top"
          placeholder="What do you need?"
          placeholderTextColor={colors.inkFaint}
          accessibilityLabel="Message to the office"
          style={styles.input}
        />

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: urgent }}
          onPress={() => setUrgent((v) => !v)}
          style={styles.urgentRow}
        >
          <View style={[styles.checkbox, urgent && styles.checkboxOn]}>
            {urgent && <Text style={styles.tick}>✓</Text>}
          </View>
          <View style={styles.urgentText}>
            <Text style={styles.urgentLabel}>This is urgent</Text>
            <Text style={styles.urgentHint}>
              Reaches the on-call manager even outside office hours
            </Text>
          </View>
        </Pressable>

        {error && (
          <Text role="alert" style={styles.error}>
            {error}
          </Text>
        )}

        {/* Honest about what "sent" means with no signal. */}
        <Text style={styles.note}>
          Messages queue on your phone and go as soon as you have signal. If
          something is urgent right now, please ring the office.
        </Text>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message to the office"
          disabled={sending}
          onPress={() => void send()}
          style={({ pressed }) => [
            styles.submit,
            { backgroundColor: pressed ? colors.nowDeep : colors.now },
            sending && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.submitLabel}>{sending ? 'Sending…' : 'Send'}</Text>
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

  sectionLabel: {
    marginTop: 8,
    marginBottom: 8,
    fontFamily: font.monoBold,
    fontSize: type.micro,
    letterSpacing: 1.2,
    color: colors.inkFaint,
  },

  quick: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    minHeight: touch.tapLg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  quickText: { flex: 1, fontFamily: font.medium, fontSize: type.body, color: colors.ink },
  quickUrgent: {
    fontFamily: font.monoBold,
    fontSize: type.micro,
    color: colors.alert,
  },

  input: {
    minHeight: 120,
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

  urgentRow: {
    marginTop: 16,
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
  urgentText: { flex: 1 },
  urgentLabel: { fontFamily: font.semibold, fontSize: type.body, color: colors.ink },
  urgentHint: { marginTop: 1, fontFamily: font.regular, fontSize: type.micro, color: colors.inkFaint },

  error: { marginTop: 12, fontFamily: font.medium, fontSize: type.small, color: colors.alert },
  note: {
    marginTop: 20,
    fontFamily: font.regular,
    fontSize: type.micro,
    lineHeight: 18,
    color: colors.inkFaint,
  },

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
