exports.collectAll=async(api)=>{const out=[];let cursor="";do{const page=await api.fetch(cursor);out.push(...page.items);cursor=page.nextCursor;}while(cursor);return out;};
