const assert=require("assert"); const {match}=require("../src/router");
assert.deepStrictEqual(match('/users/:id','/users/42'),{id:'42'}); assert.equal(match('/users/:id','/users/42/edit'),null); assert.deepStrictEqual(match('/f/:name','/f/a%20b'),{name:'a b'}); console.log("ok");
