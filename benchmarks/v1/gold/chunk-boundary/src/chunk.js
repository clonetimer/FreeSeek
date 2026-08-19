exports.chunk = function chunk(items, size) {
  if (!Number.isInteger(size) || size <= 0) throw new TypeError("size must be a positive integer");
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
