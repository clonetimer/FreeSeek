const assert=require("assert"); const {buildQuery}=require("../src/query");
assert.equal(buildQuery({q:"a b&c", tag:["x/y","z"], skip:null}), "q=a%20b%26c&tag=x%2Fy&tag=z");
assert.equal(buildQuery({"a b":"✓"}), "a%20b=%E2%9C%93"); console.log("ok");
