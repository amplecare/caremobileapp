import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Supabase client for the Carer App.
 *
 * Talks to the SAME project as the web Agency Hub, so the multi-tenant RLS
 * already verified there protects this app too — a carer's token is scoped by
 * the same `organisation_id` policies.
 *
 * Session tokens go in the **Keychain (iOS) / Keystore (Android)** via
 * expo-secure-store, never AsyncStorage. AsyncStorage is plain unencrypted
 * files: on a rooted or jailbroken handset — or a phone handed to a repair
 * shop — a token there is readable, and this token can reach real people's
 * medical records.
 */

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loudly at startup rather than with a confusing network error later.
  console.warn(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY are not set. ' +
      'Copy .env.example to .env and fill them in.',
  );
}

/**
 * SecureStore has a 2048-byte value limit on Android. A Supabase session can
 * exceed that once a JWT carries custom claims, so values are chunked rather
 * than silently truncated — a truncated token fails as an unreadable auth
 * error at 6am, which is the worst possible time to debug it.
 */
const CHUNK_SIZE = 1800;

const secureStorageAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    const head = await SecureStore.getItemAsync(key);
    if (head === null) return null;
    if (!head.startsWith('__chunks__:')) return head;

    const count = Number(head.slice('__chunks__:'.length));
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = await SecureStore.getItemAsync(`${key}__${i}`);
      if (part === null) return null; // incomplete write — treat as signed out
      parts.push(part);
    }
    return parts.join('');
  },

  setItem: async (key: string, value: string): Promise<void> => {
    if (value.length <= CHUNK_SIZE) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
    const count = Math.ceil(value.length / CHUNK_SIZE);
    for (let i = 0; i < count; i += 1) {
      await SecureStore.setItemAsync(
        `${key}__${i}`,
        value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      );
    }
    await SecureStore.setItemAsync(key, `__chunks__:${count}`);
  },

  removeItem: async (key: string): Promise<void> => {
    const head = await SecureStore.getItemAsync(key);
    if (head?.startsWith('__chunks__:')) {
      const count = Number(head.slice('__chunks__:'.length));
      for (let i = 0; i < count; i += 1) {
        await SecureStore.deleteItemAsync(`${key}__${i}`);
      }
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    // SecureStore is unavailable when rendering on web; fall back to the
    // default so `expo start --web` still boots for quick layout checks.
    storage: Platform.OS === 'web' ? undefined : secureStorageAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // No URL to parse in a native app — this would throw on some platforms.
    detectSessionInUrl: false,
  },
  global: {
    headers: { 'x-client-info': 'caremango-carer' },
  },
});
