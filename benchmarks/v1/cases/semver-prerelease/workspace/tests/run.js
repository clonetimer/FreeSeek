const assert=require("assert"); const {compare}=require("../src/semver");
assert(compare("1.0.0","1.0.0-beta")>0); assert(compare("1.0.0-beta.2","1.0.0-beta.11")<0); assert(compare("1.2.0","1.1.9")>0); assert.equal(compare("2.0.0","2.0.0"),0); console.log("ok");
