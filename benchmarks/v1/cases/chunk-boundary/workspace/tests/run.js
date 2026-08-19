const assert=require("assert"); const {chunk}=require("../src/chunk");
assert.deepStrictEqual(chunk([1,2,3,4],2), [[1,2],[3,4]]);
assert.deepStrictEqual(chunk([1,2,3,4,5],2), [[1,2],[3,4],[5]]);
assert.throws(()=>chunk([1],0)); assert.throws(()=>chunk([1],1.5)); console.log("ok");
