const assert=require("assert"); const {createCache}=require("../src/cache"); let t=1000; const c=createCache(()=>t); c.set("a",42,2);
assert.equal(c.get("a"),42); t=2999; assert.equal(c.get("a"),42); t=3000; assert.equal(c.get("a"),undefined); console.log("ok");
