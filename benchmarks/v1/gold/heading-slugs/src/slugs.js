exports.createSlugger = function createSlugger() {
  const seen=new Map(); return (heading) => { const base=heading.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-+|-+$/g,""); const n=seen.get(base)||0; seen.set(base,n+1); return n?`${base}-${n}`:base; };
};
