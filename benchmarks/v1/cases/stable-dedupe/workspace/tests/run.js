const assert = require("assert");
const { unique } = require("../src/dedupe");
assert.deepStrictEqual(unique(["b","a","b","c","a"]), ["b","a","c"]);
assert.deepStrictEqual(unique([3,1,3,2]), [3,1,2]);
console.log("ok");
