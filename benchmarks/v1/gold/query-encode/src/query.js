exports.buildQuery = function buildQuery(params) {
  const out=[];
  for (const [key,value] of Object.entries(params)) {
    if (value == null) continue;
    for (const item of Array.isArray(value) ? value : [value]) out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
  }
  return out.join("&");
};
