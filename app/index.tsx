import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckInSheet } from '../components/CheckInSheet';
import { SyncBadge } from '../components/SyncBadge';
import { useCheckInLocation } from '../hooks/useCheckInLocation';
import { enqueue } from '../lib/outbox/store';
import { colors, font, radius, touch, type } from '../theme/tokens';

/**
 * TODAY — the screen that matters.
 *
 * Opens from cache before any network call. A carer glancing at this while
 * walking must see exactly one thing: what they are doing next, and the button
 * that starts it.
 *
 * The data below is a fixture. Stage 1 of the build plan replaces it with
 * SQLite; nothing about this layout changes when it does, which is the point
 * of building the screen against a typed shape first.
 */

type VisitStatus = 'scheduled' | 'in_progress' | 'completed';

interface Visit {
  id: string;
  clientName: string;
  address: string;
  visitType: string;
  start: string;
  end: string;
  minutes: number;
  status: VisitStatus;
  /** The address geocoded. Null when the agency has not recorded one. */
  lat: number | null;
  lng: number | null;
}

const VISITS: Visit[] = [
  { id: '1', clientName: 'Albert Nkemdi', address: '55 Broughton Lane, Salford', visitType: 'Personal care', start: '08:00', end: '08:45', minutes: 45, status: 'completed', lat: 53.5012, lng: -2.2701 },
  { id: '2', clientName: 'Doris Fenwick', address: '22 Bury New Road, Manchester', visitType: 'Personal care', start: '09:15', end: '10:00', minutes: 45, status: 'in_progress', lat: 53.4934, lng: -2.2361 },
  { id: '3', clientName: 'Ronald Pike', address: '7 Kersal Way, Salford', visitType: 'Medication', start: '11:00', end: '11:45', minutes: 45, status: 'scheduled', lat: 53.5089, lng: -2.2812 },
  { id: '4', clientName: 'Maureen Ellis', address: '104 Cheetham Hill Road', visitType: 'Domestic', start: '13:00', end: '14:00', minutes: 60, status: 'scheduled', lat: null, lng: null },
];

export default function TodayScreen() {
  const insets = useSafeAreaInsets();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [visits, setVisits] = useState<Visit[]>(VISITS);

  // The hero is whatever the carer should be thinking about: the visit in
  // progress, or failing that the next one due. Everything else is a row.
  const { hero, upcoming, done } = useMemo(() => {
    const live = visits.find((v) => v.status === 'in_progress');
    const next = visits.find((v) => v.status === 'scheduled');
    const heroVisit = live ?? next ?? null;
    return {
      hero: heroVisit,
      upcoming: visits.filter((v) => v.status === 'scheduled' && v.id !== heroVisit?.id),
      done: visits.filter((v) => v.status === 'completed'),
    };
  }, [visits]);

  // Only ask for a fix while the sheet is open — no point warming the GPS
  // radio for a screen the carer is only glancing at.
  const clientPoint = useMemo(
    () => (hero ? { lat: hero.lat, lng: hero.lng } : null),
    [hero],
  );
  const { verdict, locating, coords, retry } = useCheckInLocation(clientPoint, sheetOpen);

  /**
   * Writes the check-in locally and queues it, in one transaction. The UI
   * flips immediately; the outbox delivers whenever there is signal.
   */
  const confirmCheckIn = useCallback(
    async ({ coords: c, reason }: { coords: { lat: number; lng: number; accuracy?: number | null } | null; reason: string | null }) => {
      if (!hero) return;
      const checkingIn = hero.status !== 'in_progress';
      const at = new Date().toISOString();

      setVisits((prev) =>
        prev.map((v) =>
          v.id === hero.id
            ? { ...v, status: checkingIn ? 'in_progress' : 'completed' }
            : v,
        ),
      );
      setSheetOpen(false);

      try {
        await enqueue(
          checkingIn ? 'visit.check_in' : 'visit.check_out',
          `visit-${hero.id}`,
          { visitId: hero.id, at, lat: c?.lat, lng: c?.lng, reason },
        );
      } catch {
        // The local flip already happened; tell the carer plainly rather than
        // silently pretending it is queued.
        Alert.alert('Not saved', 'Something went wrong storing that. Please try again.');
      }
    },
    [hero],
  );

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          // Room for the sticky action bar to float clear of the last row.
          paddingBottom: insets.bottom + 120,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.date}>{today}</Text>
          <SyncBadge state="synced" />
        </View>

        {hero && <HeroVisit visit={hero} />}

        {upcoming.length > 0 && (
          <Section title="Next">
            {upcoming.map((v) => (
              <VisitRow key={v.id} visit={v} />
            ))}
          </Section>
        )}

        {done.length > 0 && (
          <Section title="Done">
            {done.map((v) => (
              <VisitRow key={v.id} visit={v} />
            ))}
          </Section>
        )}

        {visits.length === 0 && <Text style={styles.empty}>No visits today.</Text>}
      </ScrollView>

      {hero && (
        <ActionBar
          visit={hero}
          bottomInset={insets.bottom}
          onPress={() => setSheetOpen(true)}
        />
      )}

      {hero && (
        <CheckInSheet
          visible={sheetOpen}
          clientName={hero.clientName}
          verdict={verdict}
          locating={locating}
          coords={coords}
          onRetryLocation={retry}
          onCancel={() => setSheetOpen(false)}
          onConfirm={confirmCheckIn}
        />
      )}
    </View>
  );
}

/**
 * The hero card. `live` is used here and nowhere else on the screen — that
 * scarcity is what makes it findable in peripheral vision.
 */
function HeroVisit({ visit }: { visit: Visit }) {
  const isLive = visit.status === 'in_progress';
  const accent = isLive ? colors.live : colors.now;

  return (
    <View style={styles.hero}>
      <View style={styles.heroKicker} accessibilityRole="header">
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <Text style={[styles.kickerText, { color: accent }]}>
          {isLive ? 'NOW' : 'NEXT'} · {visit.start}–{visit.end}
        </Text>
      </View>

      <View style={styles.heroBody}>
        <Text style={styles.heroName} numberOfLines={1}>
          {visit.clientName}
        </Text>
        <Text style={styles.heroAddress} numberOfLines={1}>
          {visit.address}
        </Text>
        <Text style={styles.heroMeta}>
          {visit.visitType} · {visit.minutes} min
        </Text>
      </View>
    </View>
  );
}

/**
 * A compact row. Times are monospaced so the column scans vertically — a carer
 * reads down the times, not across the names.
 */
function VisitRow({ visit }: { visit: Visit }) {
  const isDone = visit.status === 'completed';
  const muted = isDone ? colors.inkFaint : colors.ink;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${visit.start} visit to ${visit.clientName}, ${visit.visitType}${isDone ? ', completed' : ''}`}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: colors.surfaceSunk },
      ]}
    >
      <Text style={[styles.rowTime, { color: muted }]}>{visit.start}</Text>

      <View style={styles.rowMain}>
        <Text style={[styles.rowName, { color: muted }]} numberOfLines={1}>
          {visit.clientName}
        </Text>
        <Text style={styles.rowType} numberOfLines={1}>
          {visit.visitType}
        </Text>
      </View>

      {/* Never colour alone — the tick carries the meaning for anyone who
          cannot distinguish the green. */}
      {isDone ? (
        <Text style={styles.rowDone}>✓ Done</Text>
      ) : (
        <Text style={styles.rowMins}>{visit.minutes}m</Text>
      )}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

/**
 * The single primary action, pinned in the thumb zone.
 *
 * Its label always states the next thing to do, so a carer never has to work
 * out where they are in the flow: CHECK IN → (tasks) → CHECK OUT.
 */
function ActionBar({
  visit,
  bottomInset,
  onPress,
}: {
  visit: Visit;
  bottomInset: number;
  onPress: () => void;
}) {
  const label = visit.status === 'in_progress' ? 'Check out' : 'Check in';

  return (
    <View style={[styles.actionBar, { paddingBottom: bottomInset + 12 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} for ${visit.clientName}`}
        onPress={onPress}
        style={({ pressed }) => [
          styles.actionButton,
          { backgroundColor: pressed ? colors.nowDeep : colors.now },
        ]}
      >
        <Text style={styles.actionLabel}>{label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  date: { fontFamily: font.semibold, fontSize: type.title, color: colors.ink },
  empty: {
    marginTop: 96,
    textAlign: 'center',
    fontFamily: font.medium,
    fontSize: type.body,
    color: colors.inkSoft,
  },

  hero: {
    marginHorizontal: 20,
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  heroKicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  dot: { height: 8, width: 8, borderRadius: radius.pill },
  kickerText: { fontFamily: font.monoBold, fontSize: type.micro, letterSpacing: 1.2 },
  heroBody: { paddingHorizontal: 20, paddingBottom: 20, paddingTop: 8 },
  heroName: { fontFamily: font.bold, fontSize: type.display, color: colors.ink },
  heroAddress: {
    marginTop: 4,
    fontFamily: font.regular,
    fontSize: type.body,
    color: colors.inkSoft,
  },
  heroMeta: {
    marginTop: 12,
    fontFamily: font.medium,
    fontSize: type.small,
    color: colors.inkFaint,
  },

  section: { marginTop: 32 },
  sectionTitle: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    fontFamily: font.monoBold,
    fontSize: type.micro,
    letterSpacing: 1.2,
    color: colors.inkFaint,
  },
  sectionBody: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface,
  },

  row: {
    minHeight: touch.tapLg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  rowTime: { fontFamily: font.mono, fontSize: type.title },
  rowMain: { flex: 1 },
  rowName: { fontFamily: font.semibold, fontSize: type.body },
  rowType: { fontFamily: font.regular, fontSize: type.micro, color: colors.inkFaint },
  rowDone: { fontFamily: font.monoBold, fontSize: type.small, color: colors.done },
  rowMins: { fontFamily: font.mono, fontSize: type.small, color: colors.inkFaint },

  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  actionButton: {
    height: touch.action,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontFamily: font.bold, fontSize: type.title, color: '#FFFFFF' },
});
