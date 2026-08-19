exports.buildQuery = function buildQuery(params) {
  return Object.entries(params).map(([k,v]) => `${k}=${v}`).join("&");
};
