exports.createUser=(first,last)=>({first,last,name:`${first} ${last}`});
exports.toJSON=(user)=>({first:user.first,last:user.last,displayName:user.displayName});
