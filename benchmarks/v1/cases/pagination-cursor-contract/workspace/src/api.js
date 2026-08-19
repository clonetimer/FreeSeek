exports.makeApi=(pages)=>({fetch:async(cursor)=>{const i=cursor?Number(cursor):0; return {items:pages[i]||[], next:String(i+1 < pages.length ? i+1 : "")};}});
