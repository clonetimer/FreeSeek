exports.createCache = function createCache(now = () => Date.now()) {
  const data = new Map();
  return {
    set(key, value, ttlSeconds) { data.set(key, { value, savedAt: now(), ttlSeconds }); },
    get(key) { const row=data.get(key); if (!row) return undefined; if (now()-row.savedAt > row.ttlSeconds) { data.delete(key); return undefined; } return row.value; }
  };
};
