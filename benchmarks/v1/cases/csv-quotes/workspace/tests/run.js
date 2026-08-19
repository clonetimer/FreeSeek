const assert=require("assert"); const {parseLine}=require("../src/csv");
assert.deepStrictEqual(parseLine('a,"b,c","d""e"'), ['a','b,c','d"e']);
assert.deepStrictEqual(parseLine('"",x,'), ['','x','']);
assert.throws(()=>parseLine('a,"b')); console.log("ok");
