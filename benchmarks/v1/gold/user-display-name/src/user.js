exports.createUser=(first,last)=>({first,last,displayName:`${first} ${last}`});
exports.toJSON=(user)=>({first:user.first,last:user.last,displayName:user.displayName});
