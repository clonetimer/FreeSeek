exports.compare = function compare(a,b) {
  const aa=a.split(".").map(Number), bb=b.split(".").map(Number);
  for(let i=0;i<3;i++){ if(aa[i]!==bb[i]) return aa[i]-bb[i]; } return 0;
};
