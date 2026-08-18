import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';

import { assessLocation, type Coords, type LocationVerdict } from '../lib/location/geo';

/**
 * Gets a location fix for a check-in, and gives up quickly.
 *
 * The timeout is the whole point. `getCurrentPositionAsync` will happily sit
 * there for a minute indoors waiting for a satellite it is never going to
 * hear, and a carer standing on a doorstep in the rain is not going to wait.
 * After ten seconds we stop asking and let them check in without a fix — the
 * visit is what matters, the coordinates are supporting evidence.
 *
 * `Balanced` accuracy rather than `Highest`: `Highest` keeps the GPS radio
 * hot far longer for a precision we do not need. We are answering "is this
 * roughly the right street", not surveying a boundary, and battery across a
 * ten-visit shift matters more than twenty metres.
 */

const FIX_TIMEOUT_MS = 10_000;

export interface CheckInLocationState {
  /** Null until the first attempt resolves. */
  verdict: LocationVerdict | null;
  /** True while a fix is being sought — drives the button's spinner. */
  locating: boolean;
  /** Raw coordinates to store with the check-in, if we got any. */
  coords: Coords | null;
  /** Ask again, e.g. after the carer steps outside. */
  retry: () => void;
}

export function useCheckInLocation(
  client: { lat: number | null; lng: number | null } | null,
  /** Pass false on screens where a fix is not needed yet. */
  enabled = true,
): CheckInLocationState {
  const [verdict, setVerdict] = useState<LocationVerdict | null>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [locating, setLocating] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Guards a late fix from overwriting state after unmount or a retry.
  const activeRef = useRef(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;

    const attempt = ++activeRef.current;
    let settled = false;
    setLocating(true);

    const finish = (v: LocationVerdict, c: Coords | null) => {
      if (settled || activeRef.current !== attempt) return;
      settled = true;
      setVerdict(v);
      setCoords(c);
      setLocating(false);
    };

    // Hard stop. Whatever the OS is doing, the carer gets an answer.
    const timer = setTimeout(
      () => finish(assessLocation(null, client, 'timeout'), null),
      FIX_TIMEOUT_MS,
    );

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          // Not an error state. Plenty of carers decline, and the app has to
          // keep working for them — the reason sheet covers the gap.
          finish(assessLocation(null, client, 'denied'), null);
          return;
        }

        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        const c: Coords = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy ?? null,
        };
        finish(assessLocation(c, client), c);
      } catch {
        // A thrown error from the location stack is indistinguishable from no
        // signal as far as the carer is concerned.
        finish(assessLocation(null, client, 'unavailable'), null);
      }
    })();

    return () => {
      clearTimeout(timer);
      // Invalidate this attempt so a slow fix cannot land on a stale screen.
      activeRef.current += 1;
    };
  }, [client, enabled, nonce]);

  return { verdict, locating, coords, retry };
}
