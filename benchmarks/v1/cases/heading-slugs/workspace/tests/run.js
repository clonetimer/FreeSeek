const assert=require("assert"); const {createSlugger}=require("../src/slugs"); const s=createSlugger();
assert.equal(s(' Hello,  World! '),'hello-world'); assert.equal(s('Hello World'),'hello-world-1'); assert.equal(s('你好 世界'),'你好-世界'); console.log("ok");
