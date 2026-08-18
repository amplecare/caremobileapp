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
import * as ImagePicker from 'expo-image-picker';

import { clearDraft, enqueue, getDraft, saveDraft } from '../../lib/outbox/store';
import {
  charsRemaining,
  concernPrompt,
  detectConcerns,
  shouldShowCounter,
  validateNote,
} from '../../lib/notes/note';
import { JPEG_QUALITY, MAX_PHOTOS_PER_VISIT, checkSize, formatBytes } from '../../lib/media/photo';
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
  const [photos, setPhotos] = useState<Array<{ uri: string; bytes: number }>>([]);
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
          Alert.alert('Before you save', prompt, [
            { text: 'No, just the note', style: 'cancel', onPress: () => void submit(true) },
            {
              text: 'Yes, report it',
              onPress: () => {
                // Save the note first so nothing is lost if they abandon the
                // incident form half-way.
                void submit(true);
                router.push({
                  pathname: '/incident/[visitId]',
                  params: { visitId, clientName },
                });
              },
            },
          ]);
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

  /**
   * Photos are captured now and uploaded later — the file stays on the device
   * and the outbox pushes it to storage when there is signal. That is what
   * makes taking a picture of a pressure sore work in a basement flat.
   */
  const addPhoto = useCallback(async () => {
    if (photos.length >= MAX_PHOTOS_PER_VISIT) {
      setError(`You can attach up to ${MAX_PHOTOS_PER_VISIT} photos to a visit.`);
      return;
    }

    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera access is off. You can still write the note.');
      return;
    }

    const shot = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      // Compress on capture: a raw 12MP JPEG is ~5MB and would strand every
      // care note queued behind it on a rural connection.
      quality: JPEG_QUALITY,
      exif: false,
    });
    if (shot.canceled || !shot.assets[0]) return;

    const asset = shot.assets[0];
    const bytes = asset.fileSize ?? 0;
    const size = checkSize(bytes);
    if (!size.ok) {
      setError(size.reason);
      return;
    }

    setPhotos((prev) => [...prev, { uri: asset.uri, bytes }]);
    Haptics.selectionAsync().catch(() => {});

    try {
      await enqueue('visit.photo', `visit-${visitId}`, {
        visitId,
        localUri: asset.uri,
        fileType: asset.mimeType ?? 'image/jpeg',
      });
    } catch {
      setPhotos((prev) => prev.filter((p) => p.uri !== asset.uri));
      setError('That photo did not save. Try again.');
    }
  }, [photos.length, visitId]);

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

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take a photo for this visit"
          onPress={() => void addPhoto()}
          style={({ pressed }) => [styles.photoButton, pressed && { backgroundColor: colors.surfaceSunk }]}
        >
          <Text style={styles.photoLabel}>
            {photos.length === 0
              ? 'Add a photo'
              : `Add another photo (${photos.length})`}
          </Text>
        </Pressable>

        {photos.map((p) => (
          <View key={p.uri} style={styles.photoRow}>
            <Text style={styles.photoName} numberOfLines={1}>
              {p.uri.split('/').pop()}
            </Text>
            {/* Honest: it is on the phone until the outbox drains it. */}
            <Text style={styles.photoMeta}>
              {formatBytes(p.bytes)} · Saved on this phone
            </Text>
          </View>
        ))}

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
  photoButton: {
    marginTop: 14,
    height: touch.tapLg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoLabel: { fontFamily: font.semibold, fontSize: type.body, color: colors.ink },
  photoRow: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceSunk,
  },
  photoName: { fontFamily: font.medium, fontSize: type.small, color: colors.ink },
  photoMeta: { marginTop: 2, fontFamily: font.mono, fontSize: type.micro, color: colors.inkFaint },
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
