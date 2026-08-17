import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, touch, type, type SyncState } from '../theme/tokens';

/**
 * Sync status. Present on every screen, top-right.
 *
 * This is the single most important piece of feedback in the app. A carer must
 * never wonder "did that save?" — so the answer is always on screen, and it is
 * always honest.
 *
 * Note what it does NOT say: there is no "offline" error state. Being
 * underground in a basement flat is the normal condition of this job, not a
 * fault, and shouting about it teaches carers to ignore the indicator. The
 * only thing worth reporting is how much work is still waiting to reach the
 * agency.
 */

interface SyncBadgeProps {
  state: SyncState;
  /** How many outbox jobs are queued. Only meaningful when pending/failed. */
  count?: number;
  onPress?: () => void;
}

const PRESENTATION: Record<
  SyncState,
  {
    label: (n: number) => string;
    glyph: string;
    bg: string;
    border: string;
    fg: string;
    a11y: (n: number) => string;
  }
> = {
  synced: {
    label: () => 'All sent',
    glyph: '↻',
    bg: colors.surfaceSunk,
    border: colors.line,
    fg: colors.inkFaint,
    a11y: () => 'Everything has been sent to your agency',
  },
  pending: {
    label: (n) => `${n} waiting`,
    glyph: '↻',
    bg: colors.liveWash,
    border: colors.live,
    fg: colors.live,
    a11y: (n) =>
      `${n} ${n === 1 ? 'item is' : 'items are'} waiting to send. They will go automatically when you have signal.`,
  },
  failed: {
    label: (n) => `${n} needs attention`,
    glyph: '!',
    bg: colors.alertWash,
    border: colors.alert,
    fg: colors.alert,
    a11y: (n) =>
      `${n} ${n === 1 ? 'item' : 'items'} could not be sent. Tap to review.`,
  },
};

export function SyncBadge({ state, count = 0, onPress }: SyncBadgeProps) {
  const p = PRESENTATION[state];
  const interactive = state !== 'synced' && Boolean(onPress);

  const body = (
    <View style={[styles.badge, { backgroundColor: p.bg, borderColor: p.border }]}>
      {/* Never colour alone: the glyph carries the state too. */}
      <Text style={[styles.glyph, { color: p.fg }]}>{p.glyph}</Text>
      <Text style={[styles.label, { color: p.fg }]}>{p.label(count)}</Text>
    </View>
  );

  if (!interactive) {
    return (
      <View accessibilityRole="text" accessibilityLabel={p.a11y(count)}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={p.a11y(count)}
      onPress={onPress}
      hitSlop={8}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    minHeight: touch.tap,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  glyph: { fontFamily: font.monoBold, fontSize: type.micro },
  label: { fontFamily: font.medium, fontSize: type.micro },
});
