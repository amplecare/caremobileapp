/**
 * Design tokens in TypeScript.
 *
 * Tailwind owns styling in components, but some APIs take raw values —
 * navigator background colours, StatusBar, haptics, SVG fills, Reanimated
 * interpolations. Those read from here. The two must agree, so if you change a
 * colour, change it in `tailwind.config.js` as well.
 *
 * Direction: "field instrument". Reference points are professional equipment
 * — high contrast, no decoration, legible in a dark hallway at 6:45am and in
 * direct sunlight an hour later.
 */

export const colors = {
  ink: '#0F1417',
  inkSoft: '#48535B',
  inkFaint: '#7A858C',

  paper: '#FBFAF8',
  surface: '#FFFFFF',
  surfaceSunk: '#F2F0EC',

  line: '#E3E0DA',
  lineStrong: '#CFCBC3',

  /** Brand teal, carried over from the web app. */
  now: '#0E6E63',
  nowDeep: '#0A544B',
  nowWash: '#E6F2F0',

  /**
   * The visit happening RIGHT NOW. Appears at most once on screen — that
   * scarcity is what makes it findable at a glance while walking.
   */
  live: '#C2410C',
  liveWash: '#FDEDE4',

  done: '#15803D',
  doneWash: '#E8F5EC',

  alert: '#B91C1C',
  alertWash: '#FCEBEB',

  night: '#0B0F11',
  nightSurface: '#151B1E',
  nightLine: '#252D31',
} as const;

/** Nothing below 13. Body is 17. */
export const type = {
  micro: 13,
  small: 15,
  body: 17,
  title: 22,
  display: 28,
  hero: 34,
} as const;

export const font = {
  regular: 'Lexend_400Regular',
  medium: 'Lexend_500Medium',
  semibold: 'Lexend_600SemiBold',
  bold: 'Lexend_700Bold',
  mono: 'IBMPlexMono_500Medium',
  monoBold: 'IBMPlexMono_600SemiBold',
} as const;

/**
 * Touch targets. `tap` is the floor from the iOS HIG; `tapLg` is the floor for
 * anything a carer might hit wearing gloves or with wet hands; `action` is the
 * single primary button at the bottom of a screen.
 */
export const touch = { tap: 44, tapLg: 56, action: 64 } as const;

export const radius = { card: 18, pill: 999 } as const;

export type SyncState = 'synced' | 'pending' | 'failed';
