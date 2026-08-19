exports.chunk = function chunk(items, size) {
  const out = [];
  for (let i = 0; i + size < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
