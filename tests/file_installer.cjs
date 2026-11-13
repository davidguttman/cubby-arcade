const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {GameLibrary}=require('../desktop/host.cjs');
const {GameInstaller,validateRelease}=require('../desktop/installer.cjs');
const {sweepGameUpdates}=require('../runtime/core/hub.js');
// What a hub entry does: the host switches pending versions, then the shared core checks.
async function sweep(f){await f.installer.activatePending();await sweepGameUpdates({library:async()=>f.installer.library.entries(),catalog:async()=>f.installer.catalog,update:id=>f.installer.install(id)});}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cubby-file-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const site=path.join(root,'web');fs.mkdirSync(site);fs.writeFileSync(path.join(site,'library'),'[]');
 const lib=new GameLibrary(site,path.join(root,'games')),docs=new Map(),requests=[];let hub=true;
 const installer=new GameInstaller(lib,{fetch:async(url,options)=>{requests.push(String(url));assert.equal(options.redirect,'error');const body=docs.get(String(url));if(body===undefined)throw Error('offline');return body instanceof Response?body:new Response(body);},canActivate:()=>hub});
 installer.setCatalog([{id:'demo',title:'Demo',manifest_url:'https://game.test/manifest.json',artwork:'https://game.test/art.svg'}]);
 return {root,lib,docs,requests,installer,hub:v=>hub=v};
}
function offer(f,version='1',payload={'index.html':'<canvas/>','art.svg':'<svg/>','empty.txt':''}){
 const files=Object.fromEntries(Object.entries(payload).map(([name,body])=>{const url='https://game.test/releases/'+version+'/'+name;f.docs.set(url,body);return [name,{url,size:Buffer.byteLength(body),sha256:hash(body)}];}));
 const m={schema_version:2,id:'demo',version,runtime:'web',entrypoint:'index.html',artwork:'art.svg',files};f.docs.set('https://game.test/manifest.json',JSON.stringify(m));return m;
}
test('file release installs without ZIP; normalized inventory survives restart and updates reuse verified bytes',async t=>{
 const f=fixture(t);offer(f);await f.installer.install('demo');assert.equal(f.lib.entries()[0].version,'1');
 const installed=f.lib.release('demo');assert.equal(installed.manifest.schema_version,1);assert.equal(installed.manifest.files['index.html'],hash('<canvas/>'));
 fs.writeFileSync(path.join(f.root,'save.json'),'keep');f.requests.length=0;
 offer(f,'2',{'index.html':'<canvas>new</canvas>','art.svg':'<svg/>','empty.txt':''});await sweep(f);
 assert.equal(f.lib.entries()[0].version,'2');assert(!f.requests.some(u=>u.endsWith('/2/art.svg')));assert(!f.requests.some(u=>u.endsWith('/2/empty.txt')));
 assert.equal(fs.readFileSync(path.join(f.root,'save.json'),'utf8'),'keep');assert(fs.existsSync(path.join(f.lib.games,'demo/releases/1/index.html')));
 assert.equal(new GameLibrary(f.lib.site,f.lib.games).entries()[0].version,'2');
});
test('companion-only manifest updates preserve public metadata across install and restart, immutable within a version',async t=>{
 const f=fixture(t);offer(f);await f.installer.install('demo');
 const m=offer(f);m.companion={url:'./phone/',title:'Demo controls',artwork:'./phone/icon.png'};
 f.docs.set('https://game.test/manifest.json',JSON.stringify(m));
 await assert.rejects(f.installer.install('demo'),/Immutable release conflict/);
 assert.equal(f.lib.entries()[0].companion,undefined);
 m.version='2';f.docs.set('https://game.test/manifest.json',JSON.stringify(m));await sweep(f);
 const expected={url:'https://game.test/phone/',title:'Demo controls',artwork:'https://game.test/phone/icon.png'};
 assert.deepEqual(f.lib.entries()[0].companion,expected);
 assert.deepEqual(new GameLibrary(f.lib.site,f.lib.games).entries()[0].companion,expected);
 m.version='3';delete m.companion;f.docs.set('https://game.test/manifest.json',JSON.stringify(m));await sweep(f);
 assert.equal(f.lib.entries()[0].companion,undefined);
});
test('corrupt local bytes are not reused; partial/bad downloads and offline preserve active version; idle activation',async t=>{
 const f=fixture(t);offer(f);await f.installer.install('demo');
 const art=path.join(f.lib.release('demo').directory,'art.svg');fs.chmodSync(art,0o644);fs.writeFileSync(art,'broken');
 const m=offer(f,'2',{'index.html':'new','art.svg':'<svg/>','empty.txt':''});f.docs.delete(m.files['index.html'].url);
 await assert.rejects(f.installer.install('demo'));assert.equal(f.lib.entries()[0].version,'1');
 offer(f,'2',{'index.html':'new','art.svg':'<svg/>','empty.txt':''});f.hub(false);await f.installer.install('demo');assert.equal(f.lib.entries()[0].version,'1');assert.equal(f.installer.status().demo.phase,'pending');
 assert(f.requests.includes(m.files['art.svg'].url));f.hub(true);await f.installer.activatePending();assert.equal(f.lib.entries()[0].version,'2');
 const bad=offer(f,'3',{'index.html':'newer','art.svg':'<svg>3</svg>'});f.docs.set(bad.files['art.svg'].url,'oops');await assert.rejects(f.installer.install('demo'));assert.equal(f.lib.entries()[0].version,'2');
 f.docs.clear();await sweep(f);assert.equal(f.lib.entries()[0].version,'2');
});
test('ZIP release can migrate to same-version file manifest without downloads or save/profile changes',async t=>{
 const f=fixture(t),payload={'index.html':'<canvas/>','art.svg':'<svg/>'},m=offer(f,'1',payload);
 const internal={schema_version:1,id:'demo',version:'1',runtime:'web',entrypoint:'index.html',artwork:'art.svg',files:Object.fromEntries(Object.entries(payload).map(([name,body])=>[name,hash(body)]))};
 const directory=path.join(f.lib.games,'demo/releases/1');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(internal,null,2));
 for(const [name,body] of Object.entries(payload))fs.writeFileSync(path.join(directory,name),body);
 fs.symlinkSync('releases/1',path.join(f.lib.games,'demo/current'));await f.installer.install('demo');assert.deepEqual(f.requests,['https://game.test/manifest.json']);assert.equal(f.lib.entries()[0].version,'1');
});
test('short bodies, redirects, oversized metadata and cancelled streams cannot create an install',async t=>{
 const f=fixture(t);let m=offer(f);m.files['index.html'].size+=1;f.docs.set('https://game.test/manifest.json',JSON.stringify(m));await assert.rejects(f.installer.install('demo'));
 m=offer(f);f.docs.set(m.files['index.html'].url,Response.redirect('https://other.test/index.html'));await assert.rejects(f.installer.install('demo'));
 offer(f);f.docs.set('https://game.test/manifest.json',' '.repeat(256*1024+1));await assert.rejects(f.installer.install('demo'));
 m=offer(f);f.docs.set(m.files['index.html'].url,new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('<'));c.error(Error('interrupted'));}})));await assert.rejects(f.installer.install('demo'));assert.equal(f.lib.entries().length,0);
 assert(!fs.existsSync(path.join(f.lib.games,'demo/current')));assert.deepEqual(fs.readdirSync(f.lib.games),[]);
});
test('same version content mutation conflicts; URL-only relocation reuses verified bytes',async t=>{
 const f=fixture(t);const m=offer(f);await f.installer.install('demo');
 for(const entry of Object.values(m.files))entry.url=entry.url.replace('game.test','cdn.test');f.docs.set('https://game.test/manifest.json',JSON.stringify(m));f.requests.length=0;
 await f.installer.install('demo');assert.deepEqual(f.requests,['https://game.test/manifest.json']);
 offer(f,'1',{'index.html':'changed','art.svg':'<svg/>'});await assert.rejects(f.installer.install('demo'),/Immutable/);assert.equal(fs.readFileSync(path.join(f.lib.release('demo').directory,'index.html'),'utf8'),'<canvas/>');
});
test('malformed file metadata fails before payload fetch or writes',async t=>{
 const f=fixture(t);
 const edits=[m=>m.package={},m=>m.files=[],m=>m.files={},m=>m.files['../escape']=m.files['art.svg'],m=>m.files['manifest.json']=m.files['art.svg'],m=>m.files['art.svg/sub']=m.files['art.svg'],m=>m.files['art.svg'].url='http://game.test/a',m=>m.files['art.svg'].url='https://user:pass@game.test/a',m=>m.files['art.svg'].url='https://game.test/a#fragment',m=>m.files['art.svg'].size=-1,m=>m.files['art.svg'].size=1.5,m=>m.files['art.svg'].size=128*1024*1024,m=>m.files['art.svg'].sha256='0',m=>m.entrypoint='missing',m=>m.artwork='../bad',m=>m.attract='missing',m=>m.screenshots=['missing'],m=>m.screenshots='bad',m=>m.screenshots=Array(13).fill('art.svg'),m=>{for(let i=0;i<1001;i++)m.files['a'+i]=m.files['art.svg'];}];
 for(const unsafe of ['/absolute','bad\\path','bad\0path','a//b','a/./b','manifest.json/nested'])edits.push(m=>{m.files[unsafe]=m.files['art.svg'];});
 for(const edit of edits){const m=offer(f);edit(m);f.docs.set('https://game.test/manifest.json',JSON.stringify(m));f.requests.length=0;await assert.rejects(f.installer.install('demo'));assert.deepEqual(f.requests,['https://game.test/manifest.json']);}
 assert.equal(f.lib.entries().length,0);
});
test('symlinked reuse or release path cannot escape managed root',async t=>{
 const f=fixture(t);offer(f);await f.installer.install('demo');
 const art=path.join(f.lib.release('demo').directory,'art.svg'),outside=path.join(f.root,'outside');fs.writeFileSync(outside,'<svg/>');fs.unlinkSync(art);fs.symlinkSync(outside,art);
 offer(f,'2');await f.installer.install('demo');assert(f.requests.some(u=>u.endsWith('/2/art.svg')));assert(!fs.lstatSync(path.join(f.lib.release('demo').directory,'art.svg')).isSymbolicLink());
 const target=path.join(f.lib.games,'demo/releases/3');fs.symlinkSync(f.root,target);offer(f,'3');await assert.rejects(f.installer.install('demo'));assert.equal(f.lib.entries()[0].version,'2');
});

test('file releases reject host-ambiguous URL paths but permit spaces and Unicode',t=>{
 const f=fixture(t);
 for(const name of ['play.html ','play#1.html','play?1.html','play%231.html','play\t1.html','play\n1.html','play\x7f1.html']){
  const m=offer(f);m.files[name]=m.files['index.html'];m.entrypoint=name;
  assert.throws(()=>validateRelease(m,'demo'),/path/);
 }
 const m=offer(f);m.files['snow 雪.html']=m.files['index.html'];m.entrypoint='snow 雪.html';
 assert.equal(validateRelease(m,'demo'),m);
});

test('relative files resolve against nested publisher manifest; updates preserve saves and old files',async t=>{
 const f=fixture(t),stable='https://publisher.test/store/demo/manifest.json';
 f.installer.setCatalog([{id:'demo',title:'Demo',manifest_url:stable,artwork:'https://publisher.test/art.svg'}]);
 function relativeOffer(version,payload){
  const m=offer(f,version,payload);
  for(const [name,file] of Object.entries(m.files)){
   const body=f.docs.get(file.url);file.url=name==='art.svg'?'https://cdn.test/art.svg':version+'/files/'+name;
   f.docs.set(new URL(file.url,stable).href,body);
  }
  f.docs.set(stable,JSON.stringify(m));return m;
 }
 relativeOffer('1',{'index.html':'first','art.svg':'<svg/>'});
 await f.installer.install('demo');
 assert.deepEqual(f.requests,[stable,'https://publisher.test/store/demo/1/files/index.html','https://cdn.test/art.svg']);
 fs.writeFileSync(path.join(f.root,'save.json'),'keep');f.requests.length=0;
 relativeOffer('2',{'index.html':'second','art.svg':'<svg/>'});await f.installer.install('demo');
 assert.deepEqual(f.requests,[stable,'https://publisher.test/store/demo/2/files/index.html']);
 assert.equal(fs.readFileSync(path.join(f.root,'save.json'),'utf8'),'keep');
 assert.equal(fs.readFileSync(path.join(f.lib.games,'demo/releases/1/index.html'),'utf8'),'first');
 assert.equal(f.lib.entries()[0].version,'2');
});

test('relative URL validation rejects ambiguous and unsafe values before payload writes',async t=>{
 const f=fixture(t);
 for(const value of ['//evil.test/a','\\evil','x\\y','x\n/y','','?query','#fragment','http://evil.test/a','javascript:alert(1)','https://u:p@a.test/x','https://@a.test/x','https://a.test/x#f','https:relative','https:///missing','bad%xx','x%0ay']){
  const m=offer(f);m.files['index.html'].url=value;f.docs.set('https://game.test/manifest.json',JSON.stringify(m));f.requests.length=0;
  await assert.rejects(f.installer.install('demo'),undefined,value);assert.deepEqual(f.requests,['https://game.test/manifest.json']);
 }
 assert(!fs.existsSync(path.join(f.lib.games,'demo/current')));
});

test('root and parent relative URLs resolve without changing installed file paths',t=>{
 const f=fixture(t),m=offer(f);m.files['index.html'].url='../releases/1/index.html';m.files['art.svg'].url='/media/art.svg';
 assert.throws(()=>validateRelease(m,'demo'));
 const resolved=validateRelease(m,'demo','https://game.test/store/demo/manifest.json');
 assert.equal(resolved.files['index.html'].url,'https://game.test/store/releases/1/index.html');
 assert.equal(resolved.files['art.svg'].url,'https://game.test/media/art.svg');
 assert.equal(m.files['index.html'].url,'../releases/1/index.html');
});

test('uninstall removes all release bytes, survives restart and preserves saves on reinstall',async t=>{
 const {SaveStore}=require('../desktop/host.cjs');
 const f=fixture(t),saves=new SaveStore(path.join(f.root,'saves'));offer(f);await f.installer.install('demo');
 offer(f,'2');await f.installer.install('demo');saves.set('demo','run',{level:7});
 const other=path.join(f.lib.games,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'keep'),'yes');
 await f.installer.uninstall('demo');assert.equal(fs.existsSync(path.join(f.lib.games,'demo')),false);assert.deepEqual(f.lib.entries(),[]);
 assert.equal(f.installer.status().demo.phase,'uninstalled');assert.deepEqual(new GameLibrary(f.lib.site,f.lib.games).entries(),[]);
 assert.deepEqual(saves.get('demo','run'),{level:7});assert.equal(fs.readFileSync(path.join(other,'keep'),'utf8'),'yes');
 await f.installer.install('demo');assert.equal(f.lib.entries()[0].version,'2');assert.deepEqual(saves.get('demo','run'),{level:7});
});
test('uninstall refuses playing, active job, pending release and unsafe paths',async t=>{
 const f=fixture(t);offer(f);await f.installer.install('demo');
 f.hub(false);await assert.rejects(f.installer.uninstall('demo'),/hub|playing/i);f.hub(true);
 f.installer.jobs.set('demo',Promise.resolve());await assert.rejects(f.installer.uninstall('demo'),/busy/i);f.installer.jobs.delete('demo');
 f.installer.pending.set('demo',{});await assert.rejects(f.installer.uninstall('demo'),/busy/i);f.installer.pending.delete('demo');
 for(const id of ['../demo','/demo','demo/../other','',null,{},'unknown'])await assert.rejects(f.installer.uninstall(id));
 const original=path.join(f.root,'original');fs.renameSync(path.join(f.lib.games,'demo'),original);fs.symlinkSync(original,path.join(f.lib.games,'demo'));
 await assert.rejects(f.installer.uninstall('demo'),/symlink/i);assert(fs.existsSync(path.join(original,'current.json')));
 fs.unlinkSync(path.join(f.lib.games,'demo'));fs.renameSync(original,path.join(f.lib.games,'demo'));
 const games=f.lib.games;fs.renameSync(games,games+'-original');fs.symlinkSync(games+'-original',games);
 await assert.rejects(f.installer.uninstall('demo'),/symlink/i);assert.equal(f.lib.entries()[0].version,'1');
});
test('file manifests reject Windows aliases and case-folded file/directory collisions before writes',async t=>{
 const f=fixture(t);offer(f);await f.installer.install('demo');
 for(const extra of [{'CON.txt':'x'},{'file:stream':'x'},{'folder./a':'x'},{'art.svg.':'x'},{'ART.svg':'x'},{'Folder/a':'x','folder/b':'x'},{'dir':'x','dir/a':'y'},{'MANIFEST.JSON':'x'}]){
  offer(f,'2',{'index.html':'game','art.svg':'art',...extra});
  await assert.rejects(f.installer.install('demo'),undefined,JSON.stringify(extra));
  assert.equal(f.lib.entries()[0].version,'1');
  assert(!fs.existsSync(path.join(f.lib.games,'demo/releases/2')));
 }
});
test('portable inventory comparison rejects Unicode uppercase aliases before downloads',t=>{
 const f=fixture(t),base=offer(f),file=base.files['art.svg'];
 for(const [a,b] of [['σ.txt','ς.txt'],['I.txt','ı.txt']]){
  const manifest={...base,files:{...base.files,[a]:file,[b]:file}};
  assert.throws(()=>validateRelease(manifest,'demo'),/Conflicting package paths/,`${a} aliases ${b}`);
 }
});

test('uninstall rejects an actual in-flight auto-update and refuses escaped release directories',async t=>{
 const f=fixture(t);offer(f);await f.installer.install('demo');offer(f,'2');
 let release;const fetching=f.installer.fetch;f.installer.fetch=async(...args)=>{await new Promise(resolve=>release=resolve);return fetching(...args);};
 const check=sweep(f);await new Promise(r=>setImmediate(r));
 await assert.rejects(f.installer.uninstall('demo'),/busy/);assert.equal(f.lib.entries()[0].version,'1');
 f.installer.fetch=fetching;release();await check;assert.equal(f.lib.entries()[0].version,'2');
 const releases=path.join(f.lib.games,'demo/releases');fs.renameSync(releases,releases+'-original');fs.symlinkSync(f.root,releases);
 await assert.rejects(f.installer.uninstall('demo'),/symlink/i);assert(fs.existsSync(releases+'-original/2/index.html'));
});
test('many-file releases download several files at once, capped, and a failure settles every fetch before cleanup',async t=>{
 const f=fixture(t),payload=Object.fromEntries(Array.from({length:24},(_,i)=>['part'+i+'.js','// '+i]));payload['index.html']='<canvas/>';payload['art.svg']='<svg/>';
 offer(f,'1',payload);let live=0,peak=0;const plain=f.installer.fetch;
 f.installer.fetch=async(url,options)=>{if(url.endsWith('manifest.json'))return plain(url,options);live++;peak=Math.max(peak,live);try{await new Promise(r=>setTimeout(r,5));if(url.endsWith('part7.js')&&f.fail)throw Error('offline');return await plain(url,options);}finally{live--;}};
 await f.installer.install('demo');assert.equal(f.lib.entries()[0].version,'1');
 assert(peak>1,'downloads ran one at a time');assert(peak<=6,'too many downloads at once: '+peak);
 for(const name of Object.keys(payload))assert.equal(fs.readFileSync(path.join(f.lib.games,'demo/releases/1',name),'utf8'),payload[name]);
 f.fail=true;offer(f,'2',Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,v+' v2'])));
 await assert.rejects(f.installer.install('demo'),/offline/);assert.equal(live,0,'a fetch outlived the failed install');
 assert.equal(f.lib.entries()[0].version,'1');assert.deepEqual(fs.readdirSync(f.lib.games).filter(n=>n.startsWith('.install-')),[]);
});
