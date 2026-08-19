exports.decode=(text)=>{const x=JSON.parse(text); if(x.version===1)return x.payload; if(x.version===2)return x.data; throw new Error('unsupported');};
