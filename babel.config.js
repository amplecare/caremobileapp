module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-worklets/plugin must stay LAST — Reanimated requires it and
    // it has to see the final transformed output.
    plugins: ['react-native-worklets/plugin'],
  };
};
