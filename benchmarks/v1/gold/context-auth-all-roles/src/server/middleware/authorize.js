exports.authorize=(required)=>(user)=>{
  if (!user || !Array.isArray(user.roles)) return false;
  return required.every(role => user.roles.includes(role));
};
