exports.decode=(text)=>{const x=JSON.parse(text); if(x.version!==1) throw new Error('unsupported'); return x.payload;};
