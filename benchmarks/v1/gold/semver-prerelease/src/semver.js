function parse(v){ const [core,pre] = v.split("-",2); return {core:core.split(".").map(Number), pre:pre===undefined?null:pre.split(".")}; }
exports.compare = function compare(a,b) {
  const aa=parse(a), bb=parse(b); for(let i=0;i<3;i++){ if(aa.core[i]!==bb.core[i]) return aa.core[i]-bb.core[i]; }
  if (aa.pre===null || bb.pre===null) return aa.pre===bb.pre?0:(aa.pre===null?1:-1);
  const n=Math.max(aa.pre.length,bb.pre.length); for(let i=0;i<n;i++){ const x=aa.pre[i],y=bb.pre[i]; if(x===undefined)return -1;if(y===undefined)return 1;if(x===y)continue; const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y); if(xn&&yn)return Number(x)-Number(y); if(xn!==yn)return xn?-1:1; return x<y?-1:1; } return 0;
};
