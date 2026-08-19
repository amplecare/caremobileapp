import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import {
  Lexend_400Regular,
  Lexend_500Medium,
  Lexend_600SemiBold,
  Lexend_700Bold,
} from '@expo-google-fonts/lexend';
import {
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from '@expo-google-fonts/ibm-plex-mono';

import { installForegroundHandler } from '../lib/push/register';
import { colors } from '../theme/tokens';

// Installed once at module scope: how a notification behaves while the app is
// open is a property of the app, not of any screen.
installForegroundHandler();

/**
 * Root layout.
 *
 * Holds the splash screen until fonts are ready. That matters more here than
 * in most apps: the whole design leans on Lexend for legibility and Plex Mono
 * for aligned times, so a flash of fallback system font would reflow the
 * schedule under a carer's thumb exactly as they reach for it.
 */
SplashScreen.preventAutoHideAsync().catch(() => {
  /* Already hidden, or the module is unavailable in this environment. */
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Lexend_400Regular,
    Lexend_500Medium,
    Lexend_600SemiBold,
    Lexend_700Bold,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
  });

  useEffect(() => {
    // Hide on error too. A carer standing on a doorstep must never be held at
    // a splash screen because a font CDN had a bad day — the system font is a
    // perfectly usable fallback.
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.paper },
            animation: 'fade',
            animationDuration: 200,
          }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
