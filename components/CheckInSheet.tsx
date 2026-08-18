import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { AWAY_REASONS, needsReason, verdictMessage, type AwayReasonCode, type Coords, type LocationVerdict } from '../lib/location/geo';
import { colors, font, radius, touch, type } from '../theme/tokens';

/**
 * Check-in confirmation.
 *
 * Appears when the carer taps the big button, and its whole job is to be
 * honest about location without ever standing in the way. The primary action
 * is enabled from the moment the sheet opens — even with no fix, even 2km
 * away. If the location is unexpected, a reason is asked for, but the button
 * says "Check in" the entire time, never "Cannot check in".
 *
 * The reasons are phrased so most of them point at the office ("Address on
 * file looks wrong"), because most of the time that is the truth, and a carer
 * who feels accused by their own app stops recording things honestly.
 */

interface CheckInSheetProps {
  visible: boolean;
  clientName: string;
  verdict: LocationVerdict | null;
  locating: boolean;
  coords: Coords | null;
  onRetryLocation: () => void;
  onCancel: () => void;
  onConfirm: (args: { coords: Coords | null; reason: AwayReasonCode | null }) => void;
}

export function CheckInSheet({
  visible,
  clientName,
  verdict,
  locating,
  coords,
  onRetryLocation,
  onCancel,
  onConfirm,
}: CheckInSheetProps) {
  const insets = useSafeAreaInsets();
  const [reason, setReason] = useState<AwayReasonCode | null>(null);

  const mustExplain = verdict !== null && needsReason(verdict);
  const atAddress = verdict?.kind === 'at_address';
  // Never disabled on location grounds — only while a reason is outstanding.
  const canConfirm = !locating && (!mustExplain || reason !== null);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Close" />

      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.grabber} />

        <Text style={styles.title}>Check in to {clientName}</Text>

        {/* Location status — a statement of fact, never a warning */}
        <View
          style={[
            styles.status,
            {
              backgroundColor: atAddress ? colors.doneWash : colors.surfaceSunk,
              borderColor: atAddress ? colors.done : colors.line,
            },
          ]}
        >
          {locating ? (
            <>
              <ActivityIndicator size="small" color={colors.inkSoft} />
              <Text style={styles.statusText}>Checking where you are…</Text>
            </>
          ) : (
            <>
              <Text style={[styles.statusGlyph, { color: atAddress ? colors.done : colors.inkSoft }]}>
                {atAddress ? '✓' : '◎'}
              </Text>
              <Text style={styles.statusText}>
                {verdict ? verdictMessage(verdict) : 'Location unknown'}
              </Text>
            </>
          )}
        </View>

        {!locating && !atAddress && (
          <Pressable onPress={onRetryLocation} hitSlop={8} style={styles.retry}>
            <Text style={styles.retryText}>Try locating again</Text>
          </Pressable>
        )}

        {/* Reason picker — only when the location was unexpected */}
        {mustExplain && !locating && (
          <>
            <Text style={styles.reasonPrompt}>What&apos;s going on? Tap one.</Text>
            <ScrollView style={styles.reasonList} bounces={false}>
              {AWAY_REASONS.map((r) => {
                const selected = reason === r.code;
                return (
                  <Pressable
                    key={r.code}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setReason(r.code);
                      Haptics.selectionAsync().catch(() => {});
                    }}
                    style={[
                      styles.reason,
                      selected && { borderColor: colors.now, backgroundColor: colors.nowWash },
                    ]}
                  >
                    <View
                      style={[
                        styles.radio,
                        selected && { borderColor: colors.now, backgroundColor: colors.now },
                      ]}
                    />
                    <Text style={[styles.reasonLabel, selected && { color: colors.nowDeep }]}>
                      {r.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </>
        )}

        {/* Actions */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Check in to ${clientName}`}
          disabled={!canConfirm}
          onPress={() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            onConfirm({ coords, reason });
          }}
          style={({ pressed }) => [
            styles.confirm,
            { backgroundColor: pressed ? colors.nowDeep : colors.now },
            !canConfirm && styles.confirmDisabled,
          ]}
        >
          <Text style={styles.confirmLabel}>
            {locating ? 'Just a moment…' : 'Check in'}
          </Text>
        </Pressable>

        {mustExplain && reason === null && !locating && (
          <Text style={styles.hint}>Pick a reason above to continue</Text>
        )}

        <Pressable onPress={onCancel} style={styles.cancel} accessibilityRole="button">
          <Text style={styles.cancelLabel}>Not yet</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,20,23,0.45)' },
  sheet: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.lineStrong,
    marginBottom: 16,
  },
  title: { fontFamily: font.bold, fontSize: type.title, color: colors.ink, marginBottom: 14 },

  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    minHeight: touch.tapLg,
  },
  statusGlyph: { fontFamily: font.monoBold, fontSize: type.body },
  statusText: { flex: 1, fontFamily: font.medium, fontSize: type.small, color: colors.ink },

  retry: { alignSelf: 'flex-start', paddingVertical: 10 },
  retryText: { fontFamily: font.semibold, fontSize: type.small, color: colors.now },

  reasonPrompt: {
    marginTop: 6,
    marginBottom: 8,
    fontFamily: font.semibold,
    fontSize: type.small,
    color: colors.inkSoft,
  },
  reasonList: { maxHeight: 260 },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: touch.tapLg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.surface,
  },
  radio: {
    height: 20,
    width: 20,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.lineStrong,
  },
  reasonLabel: { flex: 1, fontFamily: font.medium, fontSize: type.body, color: colors.ink },

  confirm: {
    marginTop: 16,
    height: touch.action,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmDisabled: { opacity: 0.4 },
  confirmLabel: { fontFamily: font.bold, fontSize: type.title, color: '#FFFFFF' },

  hint: {
    marginTop: 8,
    textAlign: 'center',
    fontFamily: font.regular,
    fontSize: type.micro,
    color: colors.inkFaint,
  },
  cancel: { marginTop: 6, alignItems: 'center', paddingVertical: 12 },
  cancelLabel: { fontFamily: font.semibold, fontSize: type.small, color: colors.inkSoft },
});
