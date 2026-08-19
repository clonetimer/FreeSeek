function plain(v){ return v && typeof v === "object" && !Array.isArray(v); }
exports.mergeConfig = function mergeConfig(base, override) {
  const out = { ...base };
  for (const [key,value] of Object.entries(override || {})) {
    out[key] = plain(value) && plain(base && base[key]) ? exports.mergeConfig(base[key], value) : value;
  }
  return out;
};
