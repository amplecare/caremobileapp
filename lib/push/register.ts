import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Push registration.
 *
 * Asks for permission, gets an Expo push token, and records it against the
 * user so the alerts engine can reach this specific handset.
 *
 * Every failure path here is soft. A carer who declines notifications, or
 * whose token fetch fails on a bad connection, must still have a fully working
 * app — the schedule, check-in and notes all work without push. Push is how
 * the office reaches them faster, not a dependency of the job.
 */

export type PushRegistration =
  | { status: 'registered'; token: string }
  | { status: 'denied' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; error: string };

/**
 * Android needs an explicit channel or notifications arrive silently with no
 * heads-up banner. Two channels so quiet hours can be honoured by the OS
 * itself: routine alerts can be muted while urgent ones still break through.
 */
async function configureAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('routine', {
    name: 'Rota and updates',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });

  await Notifications.setNotificationChannelAsync('urgent', {
    name: 'Urgent — safeguarding and cover',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 300, 150, 300],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    bypassDnd: true,
  });
}

/**
 * `PRIVATE` lockscreen visibility on both channels is deliberate: an alert
 * saying "Doris Fenwick — missed medication" on a lock screen on a bus is a
 * data breach. The banner shows that something arrived; the content needs the
 * phone unlocked.
 */
export async function registerForPush(
  supabase: SupabaseClient,
  userId: string,
  organisationId: string,
): Promise<PushRegistration> {
  // A simulator cannot receive push. Say so plainly rather than failing in a
  // way that looks like a bug during development.
  if (!Device.isDevice) {
    return { status: 'unsupported', reason: 'Push notifications need a real device' };
  }

  try {
    await configureAndroidChannels();

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;

    if (!granted && existing.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }
    if (!granted) return { status: 'denied' };

    const projectId =
      // Set by EAS at build time; absent in bare Expo Go, where push still
      // works via the legacy token path.
      (Notifications as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;

    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );

    // Upsert on the token, not the user: a carer may have two handsets, and a
    // phone handed to a colleague must move to them rather than keep
    // delivering the previous owner's alerts.
    const { error } = await supabase.from('device_tokens').upsert(
      {
        organisation_id: organisationId,
        user_id: userId,
        token,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        device_name: Device.deviceName ?? null,
        active: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );

    if (error) return { status: 'failed', error: error.message };
    return { status: 'registered', token };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Retires this device's token on sign-out.
 *
 * Deactivated rather than deleted: if the same carer signs back in the row
 * revives, and meanwhile the office stops sending alerts to a phone whose
 * user has left. Failure is ignored — a carer signing out must never be held
 * up by a network call.
 */
export async function unregisterPush(supabase: SupabaseClient, token: string): Promise<void> {
  try {
    await supabase.from('device_tokens').update({ active: false }).eq('token', token);
  } catch {
    /* sign-out proceeds regardless */
  }
}

/**
 * How a notification behaves while the app is open.
 *
 * Urgent alerts interrupt; routine ones land quietly in the tray. A carer
 * mid-way through recording medication should not have a banner drop over the
 * screen because next Tuesday's rota changed.
 */
export function installForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const urgent = notification.request.content.data?.urgency === 'urgent';
      return {
        shouldShowBanner: urgent,
        shouldShowList: true,
        shouldPlaySound: urgent,
        shouldSetBadge: true,
      };
    },
  });
}
