const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');

test('desktop staging includes the native feed adapter and its shared policy dependency',async()=>{
 const file=path.resolve(__dirname,'../desktop/build.cjs'),load=createRequire(file);
 let checked=false;
 await vm.runInNewContext(await fs.readFile(file,'utf8'),{
  __dirname:path.dirname(file),process:{argv:['node',file,'linux']},console:{log(){},error(error){throw error;}},
  require:Object.assign(function(name){
   if(name==='@electron/packager')return {async packager(options){
    // Resolve from the real staged tree, not the source checkout. Missing native
    // dependencies otherwise fail before Electron can emit any startup evidence.
    const {FeedIO}=load(path.join(options.dir,'desktop/feeds.cjs'));
    const {DEFAULT_URL}=load(path.join(options.dir,'runtime/core/game-feeds.js'));
    const io=new FeedIO(path.join(options.dir,'smoke-feeds.json'));
    assert.equal(await io.read(),null);
    await assert.rejects(io.catalog('http://insecure.test/feed'),/HTTPS/);
    assert.equal(DEFAULT_URL,'https://cubby.david.app/catalog');checked=true;
    return [options.dir];
   }};
   if(name==='node:child_process')return {execFileSync(){}};
   return load(name);
  },{resolve:load.resolve})
 });
 assert.equal(checked,true);
});
