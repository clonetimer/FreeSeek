exports.authorize=(required)=>(user)=>{
  if (!user || !user.roles) return false;
  return user.roles.some(role => required.includes(role));
};
