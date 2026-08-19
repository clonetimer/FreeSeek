exports.match = function match(pattern, pathname) {
  const names=[]; const re=pattern.replace(/:([^/]+)/g,(_,n)=>{names.push(n);return "([^/]+)"});
  const m=pathname.match(new RegExp("^"+re)); if(!m)return null; return Object.fromEntries(names.map((n,i)=>[n,m[i+1]]));
};
