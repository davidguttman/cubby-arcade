const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {GameLibrary}=require('../desktop/host.cjs');
const {GameInstaller}=require('../desktop/installer.cjs');
const {sweepGameUpdates}=require('../runtime/core/hub.js');
// What a hub entry does: the host switches pending versions, then the shared core checks.
async function sweep(f){await f.installer.activatePending();await sweepGameUpdates({library:async()=>f.installer.library.entries(),catalog:async()=>f.installer.catalog,update:id=>f.installer.install(id)});}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const site=path.join(root,'web');fs.mkdirSync(site);fs.writeFileSync(path.join(site,'library'),'[]');const lib=new GameLibrary(site,path.join(root,'games'));const documents=new Map();let hub=true;const events=[];const installer=new GameInstaller(lib,{fetch:async url=>{const body=documents.get(String(url));if(body===undefined)throw Error('offline');return new Response(body);},onChange:s=>events.push(s),canActivate:()=>hub});return {root,lib,installer,documents,events,hub:v=>hub=v};}
function archive(f,version='1',options={}){const file=path.join(f.root,'fixture.zip');execFileSync('uv',['run','python','-c',`import json,zipfile,hashlib,sys\npayload={'index.html':b'<canvas/>','art.svg':b'<svg/>'}\nm=dict(schema_version=1,id='demo',version=sys.argv[2],runtime='web',entrypoint='index.html',artwork='art.svg',files={k:hashlib.sha256(v).hexdigest() for k,v in payload.items()})\nif sys.argv[4]!='':m['companion']=json.loads(sys.argv[4])\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:\n z.writestr('manifest.json',json.dumps(m))\n for k,v in payload.items(): z.writestr(k,v)\n if sys.argv[3]!='': z.writestr(sys.argv[3],b'bad')`,file,version,options.extra||'',options.companion?JSON.stringify(options.companion):'']);const bytes=fs.readFileSync(file);return {bytes,release:{schema_version:1,id:'demo',version,runtime:'web',entrypoint:'index.html',package:{url:'https://store.test/demo.zip',size:bytes.length,sha256:hash(bytes)}}};}
function offer(f,a){f.documents.set('https://store.test/demo.json',JSON.stringify(a.release));f.documents.set(a.release.package.url,a.bytes);f.installer.setCatalog([{id:'demo',title:'Demo',manifest_url:'https://store.test/demo.json',artwork:'https://store.test/art.svg'}]);}
test('installs and updates use a regular atomic selector without symlink privileges',async t=>{
 t.mock.method(fs,'symlinkSync',()=>{throw Object.assign(Error('Symlink privilege unavailable'),{code:'EPERM'});});
 const f=fixture(t);offer(f,archive(f));await f.installer.install('demo');
 const selector=path.join(f.lib.games,'demo/current.json');
 assert(fs.lstatSync(selector).isFile());assert.deepEqual(JSON.parse(fs.readFileSync(selector)),{version:'1'});
 assert(!fs.existsSync(path.join(f.lib.games,'demo/current')));
 offer(f,archive(f,'2'));await sweep(f);
 assert.deepEqual(JSON.parse(fs.readFileSync(selector)),{version:'2'});
 assert.equal(new GameLibrary(f.lib.site,f.lib.games).entries()[0].version,'2');
 for(const value of [{version:'../1'},{version:'C:1'},{version:'1.'},[],{version:'CON'}]){
  fs.writeFileSync(selector,JSON.stringify(value));assert.deepEqual(f.lib.entries(),[]);
 }
});
test('native verified installation discovers game and immutable updates retain prior bytes and saves',async t=>{const f=fixture(t);offer(f,archive(f));await f.installer.install('demo');assert.equal(f.lib.entries()[0].version,'1');fs.writeFileSync(path.join(f.root,'save.json'),'keep');offer(f,archive(f,'2'));await sweep(f);assert.equal(f.lib.entries()[0].version,'2');assert(fs.existsSync(path.join(f.lib.games,'demo/releases/1/index.html')));assert.equal(fs.readFileSync(path.join(f.root,'save.json'),'utf8'),'keep');assert(f.events.some(e=>e.demo?.phase==='downloading'));});
test('ZIP download references also resolve against their publisher manifest',async t=>{
 const f=fixture(t),a=archive(f),stable='https://publisher.test/store/demo/manifest.json';
 a.release.package.url='../releases/demo.zip';f.documents.set(stable,JSON.stringify(a.release));
 f.documents.set('https://publisher.test/store/releases/demo.zip',a.bytes);
 f.installer.setCatalog([{id:'demo',title:'Demo',manifest_url:stable,artwork:'https://publisher.test/art.svg'}]);
 await f.installer.install('demo');assert.equal(f.lib.entries()[0].version,'1');
});
test('ZIP package owns companion metadata; contradictory outer metadata never activates',async t=>{
 const f=fixture(t),companion={artwork:'https://game.test/phone/icon.png',title:'Phone controls',url:'https://game.test/phone/'};
 const a=archive(f,'1',{companion});a.release.companion={url:companion.url,title:companion.title,artwork:companion.artwork};offer(f,a);
 await f.installer.install('demo');assert.deepEqual(f.lib.entries()[0].companion,companion);
 const next=archive(f,'2',{companion});next.release.companion={url:'https://elsewhere.test/phone/'};offer(f,next);
 await assert.rejects(f.installer.install('demo'),/companion mismatch/);
 assert.equal(f.lib.entries()[0].version,'1');
});
test('bad bytes, zip traversal and identity preserve current release; retry works',async t=>{const f=fixture(t);offer(f,archive(f));await f.installer.install('demo');for(const change of ['hash','identity','traversal']){const a=archive(f,'2',change==='traversal'?{extra:'../escape'}:{});if(change==='hash')a.release.package.sha256='0'.repeat(64);if(change==='identity')a.release.id='other';offer(f,a);await assert.rejects(f.installer.install('demo'));assert.equal(f.lib.entries()[0].version,'1');}assert(!fs.existsSync(path.join(f.root,'escape')));offer(f,archive(f,'2'));await f.installer.install('demo');assert.equal(f.lib.entries()[0].version,'2');});
test('updates stage while gameplay is active and atomically activate only on returning to hub',async t=>{const f=fixture(t);offer(f,archive(f));await f.installer.install('demo');offer(f,archive(f,'2'));f.hub(false);await sweep(f);assert.equal(f.lib.entries()[0].version,'1');assert.equal(f.installer.status().demo.phase,'pending');f.hub(true);await f.installer.activatePending();assert.equal(f.lib.entries()[0].version,'2');f.documents.clear();await sweep(f);assert.equal(f.lib.entries()[0].version,'2');});
test('only registered ids are installable, unsafe transport rejected, duplicate work is shared',async t=>{const f=fixture(t);await assert.rejects(f.installer.install('unknown'));const a=archive(f);offer(f,a);await Promise.all([f.installer.install('demo'),f.installer.install('demo')]);assert.equal(f.lib.entries().length,1);a.release.package.url='http://store.test/demo.zip';offer(f,a);await assert.rejects(f.installer.install('demo'));});
test('ZIP inventory rejects duplicate/unlisted entries, directories, symlinks, oversized metadata and bad digests',async t=>{
 const f=fixture(t);offer(f,archive(f));await f.installer.install('demo');
 for(const change of ['duplicate','unlisted','directory','symlink','metadata','digest']){
  const a=archive(f,'2');const file=path.join(f.root,'mutated.zip');fs.writeFileSync(file,a.bytes);
  execFileSync('uv',['run','python','-c',`import zipfile,sys,json\np=sys.argv[1];kind=sys.argv[2]\nwith zipfile.ZipFile(p) as z: entries={i.filename:z.read(i) for i in z.infolist()}\nif kind=='metadata':entries['manifest.json']=b' '*(256*1024+1)\nif kind=='digest':\n m=json.loads(entries['manifest.json']);m['files']['art.svg']='0'*64;entries['manifest.json']=json.dumps(m).encode()\nwith zipfile.ZipFile(p,'w') as z:\n for k,v in entries.items():z.writestr(k,v)\n if kind=='duplicate':z.writestr('index.html',b'duplicate')\n if kind=='unlisted':z.writestr('other.html',b'unlisted')\n if kind=='directory':z.writestr('folder/',b'')\n if kind=='symlink':\n  i=zipfile.ZipInfo('link');i.create_system=3;i.external_attr=0o120777<<16;z.writestr(i,b'index.html')`,file,change],{stdio:['ignore','ignore','pipe']});
  a.bytes=fs.readFileSync(file);a.release.package.size=a.bytes.length;a.release.package.sha256=hash(a.bytes);offer(f,a);
  await assert.rejects(f.installer.install('demo'),undefined,change);assert.equal(f.lib.entries()[0].version,'1');
 }
});
test('fresh profile never auto-installs bundled games; explicit installs survive restart',async t=>{
 const f=fixture(t);const a=archive(f);offer(f,a);
 fs.writeFileSync(path.join(f.lib.site,'library'),JSON.stringify([{id:'demo',version:'1',runtime:'web',entrypoint:'/games/demo/index.html',artwork:'/games/demo/art.svg'}]));
 assert.deepEqual(f.lib.entries(),[]);
 await sweep(f);assert.deepEqual(f.lib.entries(),[]);
 await f.installer.install('demo');
 assert.equal(new GameLibrary(f.lib.site,f.lib.games).entries()[0].version,'1');
 f.documents.clear();await sweep(f);assert.equal(f.lib.entries()[0].version,'1');
});
test('Windows native readonly recursive-removal control records filesystem semantics', {skip:process.platform!=='win32'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cubby-readonly-control-')),tree=path.join(root,'game'),file=path.join(tree,'readonly.txt');
 t.after(()=>{if(fs.existsSync(file))fs.chmodSync(file,0o600);fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(tree);fs.writeFileSync(file,'control',{mode:0o444});
 let result='removed';try{fs.rmSync(tree,{recursive:true});}catch(error){assert(['EPERM','EACCES'].includes(error.code));result=error.code;}
 console.log(JSON.stringify({windowsReadonlyRemoval:result,node:process.version}));
 if(result!=='removed'){fs.chmodSync(file,0o600);fs.rmSync(tree,{recursive:true});}
 assert(!fs.existsSync(tree));
});
test('uninstall clears Windows readonly attributes only within the owned game tree',async t=>{
 const f=fixture(t);offer(f,archive(f));await f.installer.install('demo');
 const game=path.join(f.lib.games,'demo'),asset=path.join(game,'releases/1/index.html'),save=path.join(f.root,'save.json');
 fs.writeFileSync(save,'retain',{mode:0o600});fs.chmodSync(asset,0o444);
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
 Object.defineProperty(process,'platform',{...descriptor,value:'win32'});t.after(()=>Object.defineProperty(process,'platform',descriptor));
 const remove=fs.rmSync;
 t.mock.method(fs,'rmSync',(target,...args)=>{
  if(target===game&&!(fs.statSync(asset).mode&0o200))throw Object.assign(Error('Readonly Windows asset'),{code:'EPERM'});
  return remove(target,...args);
 });
 await f.installer.uninstall('demo');
 assert(!fs.existsSync(game));assert.equal(fs.readFileSync(save,'utf8'),'retain');assert.deepEqual(f.lib.entries(),[]);
});
