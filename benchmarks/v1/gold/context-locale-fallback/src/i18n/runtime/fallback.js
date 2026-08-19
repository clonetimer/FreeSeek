exports.fallbackChain=function(locale){
  const parts=locale.split('-').filter(Boolean); const out=[]; for(let i=parts.length;i>=1;i--) out.push(parts.slice(0,i).join('-')); if(!out.includes('en')) out.push('en'); return out;
};
