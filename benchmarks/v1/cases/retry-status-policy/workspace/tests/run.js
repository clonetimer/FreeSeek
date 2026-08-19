const assert=require("assert"); const {shouldRetry}=require("../src/retry");
for(const x of [408,429,500,503,599]) assert.equal(shouldRetry(x),true,x); for(const x of [400,401,403,404,422,600]) assert.equal(shouldRetry(x),false,x); console.log("ok");
