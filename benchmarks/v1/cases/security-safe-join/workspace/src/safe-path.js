const path=require('path'); exports.safeJoin=(root,child)=>{const target=path.resolve(root,child); if(!target.startsWith(path.resolve(root))) throw new Error('outside'); return target;};
