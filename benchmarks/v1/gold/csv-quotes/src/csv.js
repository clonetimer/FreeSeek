exports.parseLine = function parseLine(line) {
  const out=[]; let current=""; let quoted=false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (quoted && ch==='"' && line[i+1]==='"') { current+='"'; i++; }
    else if (ch==='"') quoted=!quoted;
    else if (ch===',' && !quoted) { out.push(current); current=""; }
    else current+=ch;
  }
  if (quoted) throw new Error("unterminated quoted field");
  out.push(current); return out;
};
