const assert=require("assert"); const {mergeConfig}=require("../src/config");
const base={db:{host:"localhost",pool:{min:1,max:10}}, features:["a"], log:{level:"info"}};
const got=mergeConfig(base,{db:{pool:{max:20}},features:["b"]});
assert.deepStrictEqual(got,{db:{host:"localhost",pool:{min:1,max:20}},features:["b"],log:{level:"info"}});
assert.deepStrictEqual(base.db.pool,{min:1,max:10}); console.log("ok");
