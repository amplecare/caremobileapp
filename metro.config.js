const { getDefaultConfig } = require('expo/metro-config');

/**
 * Stock Expo Metro config.
 *
 * NativeWind was evaluated and dropped: v4 (the current stable) is
 * incompatible with the Metro shipped in SDK 57 — bundling dies with
 * "Cannot read properties of undefined (reading 'transformFile')" — and v5 is
 * still a preview. A care record app should not depend on a preview-stage
 * build tool, so styling uses React Native StyleSheet against the tokens in
 * theme/tokens.ts. Revisit when NativeWind v5 reaches stable.
 */
module.exports = getDefaultConfig(__dirname);
