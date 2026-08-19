exports.mergeConfig = function mergeConfig(base, override) {
  return { ...base, ...override };
};
