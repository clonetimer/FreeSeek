exports.makeApi=(pages)=>({fetch:async(cursor)=>{const i=cursor?Number(cursor):0; return {items:pages[i]||[], nextCursor:i+1 < pages.length ? String(i+1) : ""};}});
