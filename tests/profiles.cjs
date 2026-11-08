// Players keep their saves apart. The first player is the storage every earlier Cubby
// used, untouched; every host's real bridge and real frozen game releases are run here.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),Module=require('node:module');
const Profiles=require('../runtime/core/profiles.js'),Avatars=require('../runtime/core/avatars.js');
const {createPlatform}=require('../runtime/core/platform.js');
const {createBridge}=require('../runtime/core/browser-store.js');
const {ProfileSaves}=require('../desktop/host.cjs');
const {FIRST}=Profiles;
function storage(entries=[]){const values=new Map(entries);return {values,get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:k=>values.has(k)?values.get(k):null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear()};}
function players(store,list,active=list[0].id){store.setItem(Profiles.REGISTRY_KEY,JSON.stringify({profiles:list,active}));}
const two=[{id:FIRST,avatar:'bear'},{id:'p_second1',avatar:'fox'}];

test('two players save the same game apart, and the first player keeps the old keys',()=>{
 const s=storage([['handheld:trail-mix:camp','{"level":3}'],['handheld:preferences:v1','{"touchOverlay":"auto"}']]);
 const first=createPlatform({storage:Profiles.scopeStorage(s,FIRST),document:{}}),second=createPlatform({storage:Profiles.scopeStorage(s,'p_second1'),document:{}});
 assert.equal(Profiles.scopeStorage(s,FIRST),s,'The first player is the unchanged storage');
 assert.deepEqual(first.saves('trail-mix').get('camp'),{level:3});
 assert.equal(second.saves('trail-mix').get('camp'),null);
 second.saves('trail-mix').set('camp',{level:1});
 assert.deepEqual(first.saves('trail-mix').get('camp'),{level:3});assert.deepEqual(second.saves('trail-mix').get('camp'),{level:1});
 assert.equal(s.getItem('handheld:trail-mix:camp'),'{"level":3}');assert.equal(s.getItem('cubby:profile:p_second1:handheld:trail-mix:camp'),'{"level":1}');
 // Cubby's own settings stay shared when a game page reads them.
 assert.equal(Profiles.scopeStorage(s,'p_second1').getItem('handheld:preferences:v1'),'{"touchOverlay":"auto"}');
});
test('scoped storage behaves like Storage without reaching outside its player',()=>{
 const s=storage([['handheld:one:run','1'],['cubby:profile:p_other:handheld:one:run','2']]),scoped=Profiles.scopeStorage(s,'p_mine');
 scoped.setItem('linecutter_run','{"a":1}');scoped.loose='x';
 assert.equal(scoped.length,2);assert.deepEqual([scoped.key(0),scoped.key(1)].sort(),['linecutter_run','loose']);assert.equal(scoped.loose,'x');assert.equal('loose' in scoped,true);
 delete scoped.loose;assert.equal(scoped.getItem('loose'),null);scoped.clear();
 assert.equal(scoped.length,0);assert.equal(s.getItem('handheld:one:run'),'1');assert.equal(s.getItem('cubby:profile:p_other:handheld:one:run'),'2');
});
test('save management lists and resets one player only, and the first player sees exactly the old namespace',async()=>{
 const s=storage([['handheld:one:run','1'],['linecutter_run','{}'],['handheld:favorites:v1','[]'],['cubby:profile:p_second1:handheld:one:run','2'],['cubby:profile:p_second1:handheld:two:run','3'],['cubby:profile:p_second1:linecutter_run','{}'],[Profiles.REGISTRY_KEY,'{}']]);
 const p=createPlatform({storage:s,document:{}});
 assert.deepEqual(await p.savedGames(),['line-cutter','one']);assert.deepEqual(await p.savedGames(FIRST),['line-cutter','one']);
 assert.deepEqual(await p.savedGames('p_second1'),['line-cutter','one','two']);
 await p.resetGameSaves('one','p_second1');
 assert.equal(s.getItem('cubby:profile:p_second1:handheld:one:run'),null);assert.equal(s.getItem('handheld:one:run'),'1');assert.equal(s.getItem('cubby:profile:p_second1:handheld:two:run'),'3');
 await p.resetGameSaves('line-cutter',FIRST);assert.equal(s.getItem('linecutter_run'),null);assert.equal(s.getItem('cubby:profile:p_second1:linecutter_run'),'{}');
});
test('removing a player deletes only that player: prefixed storage, or the first player’s game saves and nothing else',async()=>{
 const s=storage([['handheld:one:run','1'],['linecutter_run','{}'],['handheld:preferences:v1','{}'],['cubby:controller-labels:v1','{}'],['cubby:profile:p_second1:handheld:one:run','2'],['cubby:profile:p_second1:handheld:favorites:v1','["one"]'],['cubby:profile:p_third1:handheld:one:run','3']]);
 players(s,[...two,{id:'p_third1',avatar:'owl'}]);
 const p=createPlatform({storage:s,document:{}});
 await p.removeProfile('p_second1');
 assert.deepEqual([...s.values.keys()].filter(k=>k.includes('p_second1')),[]);assert.equal(s.getItem('cubby:profile:p_third1:handheld:one:run'),'3');assert.equal(s.getItem('handheld:one:run'),'1');
 await p.removeProfile(FIRST);
 assert.equal(s.getItem('handheld:one:run'),null);assert.equal(s.getItem('linecutter_run'),null);
 for(const kept of ['handheld:preferences:v1','cubby:controller-labels:v1',Profiles.REGISTRY_KEY,'cubby:profile:p_third1:handheld:one:run'])assert.notEqual(s.getItem(kept),null,kept);
});
test('player ids are generated, validated and can never be a game, system or path',async()=>{
 for(const bad of [undefined,'','p_','first','favorites','preferences','trail-mix','P_ABC','p_ABC','p_a/b','p_..','../p_x','p_'+'a'.repeat(25),'p_a b',{}])assert.equal(Profiles.validId(bad),false,String(bad));
 for(const bad of ['../x','favorites','trail-mix'])assert.throws(()=>Profiles.prefix(bad));
 const p=createPlatform({storage:storage(),document:{}});
 for(const bad of ['../p_x','trail-mix','favorites'])await assert.rejects(p.savedGames(bad));await assert.rejects(p.resetGameSaves('one','nope'));await assert.rejects(p.removeProfile(undefined));
 const s=storage(),made=Profiles.createProfiles({storage:s,platform:{}});
 for(const avatar of ['frog','bear','bunny','panda','owl','cat','chick']){const {id}=made.add(avatar);assert.match(id,/^p_[a-z0-9]{10}$/);assert.equal(/^[a-z0-9][a-z0-9-]*$/.test(id),false,'A player id is never a game id');}
 assert.equal(new Set(made.list().map(x=>x.id)).size,8);assert.throws(()=>made.add('fox'),/No pictures left/);
 // A damaged registry falls back to the first player, never to a guessed id.
 for(const raw of ['{','[]','{"profiles":[{"id":"../x","avatar":"fox"}]}','{"profiles":[{"id":"p_a","avatar":"fox"},{"id":"p_a","avatar":"cat"}]}','{"profiles":[{"id":"p_a","avatar":"dragon"}]}']){
  const broken=storage([[Profiles.REGISTRY_KEY,raw]]);assert.deepEqual(Profiles.readRegistry(broken).profiles,[{id:FIRST,avatar:'cubby'}]);
 }
});
test('a fresh Cubby is one player, Cubby, and writes nothing until a child names it',async()=>{
 const s=storage(),session=storage(),removed=[],used=[];
 const made=Profiles.createProfiles({storage:s,session,platform:{removeProfile:async id=>removed.push(id),useProfile:async id=>used.push(id)},random:(()=>{let n=0;return ()=>(n++%36)/36;})()});
 assert.deepEqual(made.list(),[{id:FIRST,avatar:'cubby',name:'Cubby',named:false}]);assert.equal(made.fresh(),true);assert.equal(made.claimTarget(),FIRST);
 await made.enter(FIRST);assert.equal(s.length,0,'Playing as Cubby never writes the registry');assert.deepEqual(used,[FIRST]);
 assert.throws(()=>made.claim('dragon','Theo'));assert.throws(()=>made.claim('fox','  '),/required/);assert.throws(()=>made.setAvatar(FIRST,'cubby'),/Unknown picture/,'The house is only for a fresh Cubby');
 const theo=made.claim('fox','Theo');assert.deepEqual(theo,{id:FIRST,avatar:'fox',name:'Theo',named:true},'The first + is Cubby renamed in place');
 assert.equal(made.fresh(),false);assert.deepEqual(JSON.parse(s.getItem(Profiles.REGISTRY_KEY)).profiles,[{id:FIRST,avatar:'fox',name:'Theo'}]);
 const mia=made.claim('bear','Mia');assert.notEqual(mia.id,FIRST);assert.equal(made.list().length,2,'After that + adds');assert.equal(made.claimTarget(),null);
 assert.throws(()=>made.claim('owl','theo'),/already used/);assert.throws(()=>made.claim('fox','Al'),/already used/,'A taken animal is refused');
 await made.select(mia.id);assert.equal(made.pinned(),mia.id);
 await made.remove(mia.id);assert.deepEqual(removed,[mia.id]);assert.equal(made.pinned(),FIRST,'Removing the pinned player pins the next one');
 assert.deepEqual(made.list(),[{id:FIRST,avatar:'fox',name:'Theo',named:true}],'The one left stays as they are');
 await made.remove(FIRST);assert.deepEqual(removed,[mia.id,FIRST]);assert.equal(s.getItem(Profiles.REGISTRY_KEY),null,'The last one removed leaves a fresh Cubby');
 assert.equal(made.fresh(),true);await assert.rejects(made.remove(FIRST),/Already fresh/);await assert.rejects(made.select('p_missing'));
});
test('the first + keeps every save Cubby had: same id, same storage, in a real game page',async()=>{
 const s=storage([['handheld:trail-mix:camp','{"level":7}'],['linecutter_run','{"round":3}']]);
 const made=Profiles.createProfiles({storage:s,session:storage(),platform:{}});
 made.claim('owl','Theo');
 const p=createPlatform({storage:s,document:{}});assert.deepEqual(await p.savedGames(made.current()),['line-cutter','trail-mix']);
 const page=gamePage(s,storage([[Profiles.PIN_KEY,made.current()]]));loadFrozen(page,frozen[0]);
 assert.equal(page.win.localStorage,s,'Theo plays on exactly the storage Cubby used');assert.deepEqual(page.run(play('trail-mix')).saves.get('camp'),{level:7});
 const mia=made.claim('bear','Mia'),other=gamePage(s,storage([[Profiles.PIN_KEY,mia.id]]));loadFrozen(other,frozen[0]);
 const host=other.run(play('trail-mix'));assert.equal(host.saves.get('camp'),null,'A new player starts fresh');host.saves.set('camp',{level:1});
 assert.equal(s.getItem('handheld:trail-mix:camp'),'{"level":7}');
});
test('+ runs out with the animals: eight players, then none',()=>{
 const made=Profiles.createProfiles({storage:storage(),platform:{}});
 Profiles.AVATARS.forEach((avatar,i)=>made.claim(avatar,'Kid '+String.fromCharCode(65+i)));
 assert.equal(made.list().length,8);assert.deepEqual(made.freeAvatars(),[]);assert.throws(()=>made.claim('fox','Zed'));
});
test('a failed removal keeps the player listed, and a failed host switch keeps the old player',async()=>{
 const s=storage();players(s,two);const session=storage();
 const made=Profiles.createProfiles({storage:s,session,platform:{removeProfile:async()=>{throw Error('disk')},useProfile:async()=>{throw Error('ipc')}}});
 await assert.rejects(made.remove('p_second1'),/disk/);assert.equal(made.list().length,2);
 await assert.rejects(made.select('p_second1'),/ipc/);assert.equal(made.current(),FIRST);assert.equal(made.pinned(),null);
 assert.rejects(Profiles.createProfiles({storage:s,platform:{}}).remove('p_second1'),/unavailable/);
});
test('the tab pin decides the player of a game page; the registry is the fallback',()=>{
 const s=storage(),session=storage();players(s,two,'p_second1');
 assert.equal(Profiles.current({storage:s,session}),'p_second1');
 session.setItem(Profiles.PIN_KEY,FIRST);assert.equal(Profiles.current({storage:s,session}),FIRST);
 session.setItem(Profiles.PIN_KEY,'p_gone');assert.equal(Profiles.current({storage:s,session}),'p_second1');
 assert.equal(Profiles.current({storage:storage(),session}),FIRST);
});
test('player pictures are drawn shapes with distinct colors, one per player slot',()=>{
 assert.deepEqual([...Avatars.ids],[...Profiles.AVATARS]);
 assert.equal(new Set(Avatars.ids.map(Avatars.color)).size,Avatars.ids.length);
 for(const id of Avatars.ids){const svg=Avatars.svg(id);assert.match(svg,/^<svg class="avatar-art" viewBox="0 0 100 100" aria-hidden="true">/);assert.doesNotMatch(svg,/<text|[\u{1F300}-\u{1FAFF}]/u,'No words or emoji font');assert.ok(Avatars.name(id));}
 assert.throws(()=>Avatars.svg('__proto__'));
});

// Game pages: each frozen SDK copy that published releases ship, byte for byte.
const frozen=fs.readdirSync(path.join(__dirname,'fixtures/frozen-sdk')).sort();
const profileSource=fs.readFileSync(path.join(__dirname,'../runtime/core/profiles.js'),'utf8');
function gamePage(real,session,{options,marked=true}={}){
 const win={sessionStorage:session,console,JSON,Error,Object,Set,Map,Proxy,String,Promise,document:{currentScript:{hasAttribute:name=>marked&&name==='data-cubby-profile'}}};win.window=win;
 Object.defineProperty(win,'localStorage',{configurable:true,enumerable:true,get:()=>real});
 if(options)win.HandheldPlatformOptions=options;
 const context=vm.createContext(win);vm.runInContext(profileSource,context);
 win.document.currentScript=null;
 return {win,run:(source)=>vm.runInContext(source,context)};
}
function loadFrozen(page,hash){
 const dir=path.join(__dirname,'fixtures/frozen-sdk',hash);
 for(const name of ['platform.js','sdk.js']){const bytes=fs.readFileSync(path.join(dir,name));if(name==='platform.js')assert.equal(crypto.createHash('sha256').update(bytes).digest('hex').slice(0,12),hash,'Fixture bytes are the published release');page.run(bytes.toString('utf8'));}
}
// Exactly what each game's play.html does, minus input.
const play=(game,legacy)=>`(()=>{const platform=HandheldPlatform.createPlatform(window.HandheldPlatformOptions);return HandheldSDK.createGameHost({platform,gameId:${JSON.stringify(game)},${legacy?'legacySaveKeys:'+JSON.stringify(legacy)+',':''}inputFactory:()=>({dispose(){}}),target:{},document:{}});})()`;
for(const hash of frozen)test('frozen release SDK '+hash+' saves per player in an injected game page',()=>{
 const real=storage([['handheld:trail-mix:camp','{"level":7}'],['linecutter_run','{"round":2}'],['handheld:preferences:v1','{"p":1}']]);players(real,two);
 const session=storage([[Profiles.PIN_KEY,'p_second1']]);
 const page=gamePage(real,session);loadFrozen(page,hash);
 const host=page.run(play('trail-mix'));assert.equal(host.saves.get('camp'),null,'The second player starts fresh');
 host.saves.set('camp',{level:1});
 assert.equal(real.getItem('cubby:profile:p_second1:handheld:trail-mix:camp'),'{"level":1}');assert.equal(real.getItem('handheld:trail-mix:camp'),'{"level":7}');
 // Line Cutter's engine writes localStorage itself; its SDK alias goes through the platform.
 page.run(`localStorage.setItem('linecutter_seen','{"x":1}')`);assert.equal(real.getItem('cubby:profile:p_second1:linecutter_seen'),'{"x":1}');assert.equal(real.getItem('linecutter_seen'),null);
 assert.equal(page.run(play('line-cutter',{run:'linecutter_run'})).saves.get('run'),null);
 assert.equal(page.run(`localStorage.getItem('handheld:preferences:v1')`),'{"p":1}','Cubby settings stay shared');
 // The first player's page is untouched: same storage object, same keys.
 const firstSession=storage([[Profiles.PIN_KEY,FIRST]]),firstPage=gamePage(real,firstSession);loadFrozen(firstPage,hash);
 assert.equal(firstPage.win.localStorage,real);assert.equal(firstPage.win.HandheldPlatformOptions,undefined);
 assert.deepEqual(firstPage.run(play('trail-mix')).saves.get('camp'),{level:7});assert.deepEqual(firstPage.run(play('line-cutter',{run:'linecutter_run'})).saves.get('run'),{round:2});
});
for(const hash of frozen)test('frozen release SDK '+hash+' still scopes saves when a browser keeps its own localStorage',()=>{
 const real=storage();players(real,two);const session=storage([[Profiles.PIN_KEY,'p_second1']]);
 const page=gamePage(real,session);Object.defineProperty(page.win,'localStorage',{configurable:true,get:()=>real});
 loadFrozen(page,hash);page.run(play('small-change')).saves.set('day',{n:2});
 assert.equal(real.getItem('cubby:profile:p_second1:handheld:small-change:day'),'{"n":2}');assert.equal(real.getItem('handheld:small-change:day'),null);
});
for(const hash of frozen)test('frozen release SDK '+hash+' on desktop saves natively for the host’s player and migrates legacy keys from that player only',()=>{
 const real=storage([['linecutter_run','{"round":9}'],['cubby:profile:p_second1:linecutter_run','{"round":1}']]);players(real,two);
 const disk=new Map(),bridge={saves:game=>({get:k=>disk.has(game+'/'+k)?disk.get(game+'/'+k):null,set:(k,v)=>disk.set(game+'/'+k,v),remove:k=>disk.delete(game+'/'+k)})};
 const page=gamePage(real,storage([[Profiles.PIN_KEY,'p_second1']]),{options:Object.freeze({kind:'desktop',bridge})});loadFrozen(page,hash);
 assert.deepEqual(page.run(play('line-cutter',{run:'linecutter_run'})).saves.get('run'),{round:1});assert.deepEqual(disk.get('line-cutter/run'),{round:1});
});
test('an unmarked page (the hub) is never rescoped',()=>{
 const real=storage();players(real,two);const page=gamePage(real,storage([[Profiles.PIN_KEY,'p_second1']]),{marked:false});
 assert.equal(page.win.localStorage,real);assert.equal(page.win.HandheldPlatformOptions,undefined);
});

// Hosts. Each is its real bridge: profiles work wherever a host can keep players apart.
test('the handheld host keeps players in browser storage and lists the adult page',async()=>{
 const win={CubbyDeviceToken:'t',addEventListener(){},fetch:async()=>({ok:true,json:async()=>[]})};
 vm.runInNewContext(fs.readFileSync('rocknix/bridge.js','utf8'),{window:win,setTimeout,setInterval,clearInterval,JSON,Error,Set,Promise,requestAnimationFrame(){},navigator:{}});
 const s=storage([['cubby:profile:p_second1:handheld:one:run','1']]),p=createPlatform({...win.HandheldPlatformOptions,storage:s});
 assert.equal(p.capabilities.profiles,true);assert.deepEqual(await p.savedGames('p_second1'),['one']);
 assert.ok(p.settings.some(entry=>entry.href==='#adult-players'&&entry.icon==='players'));
});
test('the browser host keeps players in browser storage',()=>{
 const bridge=createBridge({caches:{},crypto:{},fetch:async()=>({ok:false}),origin:'https://x.test',metadata:{list:async()=>[],get:async()=>({}),change:async()=>{}}});
 assert.equal(createPlatform({kind:'web',bridge,storage:storage()}).capabilities.profiles,true);
});
function preload(){
 const load=Module._load;let exposed;const invoked=[];
 Module._load=function(name,...rest){return name==='electron'?{contextBridge:{exposeInMainWorld(_key,value){exposed=value;}},ipcRenderer:{invoke:async(channel,...args)=>{invoked.push([channel,...args]);return [];},on(){},removeListener(){},sendSync(){return {};}}}:load.call(this,name,...rest);};
 try{delete require.cache[require.resolve('../desktop/preload.cjs')];require('../desktop/preload.cjs');}finally{Module._load=load;}
 return {exposed,invoked};
}
test('the desktop host tells its main process the player and removes that player’s disk saves',async()=>{
 const {exposed,invoked}=preload(),p=createPlatform({...exposed,storage:storage()});
 assert.equal(p.capabilities.profiles,true);
 const made=Profiles.createProfiles({storage:storage(),session:storage(),platform:p});const second=made.add('owl');
 await made.select(second.id);await p.savedGames(second.id);await p.resetGameSaves('one',second.id);await made.remove(second.id);
 assert.deepEqual(invoked,[['hub:profile',second.id],['hub:saved-games',second.id],['hub:reset-game-saves','one',second.id],['hub:remove-profile',second.id]]);
 // A desktop app from before players, running a newer cloud hub, keeps one player.
 const old={...exposed.bridge};delete old.useProfile;delete old.removeProfile;
 assert.equal(createPlatform({kind:'desktop',bridge:old,storage:storage()}).capabilities.profiles,false);
});
test('desktop disk saves: the first player keeps the old directory, others get their own',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cubby-players-'));
 try{
  fs.mkdirSync(path.join(root,'saves/trail-mix'),{recursive:true});fs.writeFileSync(path.join(root,'saves/trail-mix/camp.json'),'{"level":7}');
  const saves=new ProfileSaves(root);
  assert.deepEqual(saves.store(FIRST).get('trail-mix','camp'),{level:7});assert.equal(saves.store('p_second1').get('trail-mix','camp'),null);
  saves.store('p_second1').set('trail-mix','camp',{level:1});saves.store('p_third1').set('trail-mix','camp',{level:2});
  assert.equal(fs.readFileSync(path.join(root,'profile-saves/p_second1/trail-mix/camp.json'),'utf8'),'{"level":1}');
  saves.store('p_second1').resetGameSaves('trail-mix');assert.deepEqual(saves.store(FIRST).get('trail-mix','camp'),{level:7});assert.deepEqual(saves.store('p_third1').get('trail-mix','camp'),{level:2});
  saves.remove('p_third1');assert.equal(fs.existsSync(path.join(root,'profile-saves/p_third1')),false);assert.deepEqual(saves.store(FIRST).get('trail-mix','camp'),{level:7});
  saves.remove(FIRST);assert.equal(saves.store(FIRST).get('trail-mix','camp'),null);assert.equal(fs.existsSync(path.join(root,'saves')),true);
  for(const bad of ['../saves','trail-mix','favorites','p_A',''])assert.throws(()=>saves.store(bad));
  fs.mkdirSync(path.join(root,'elsewhere'));fs.symlinkSync(path.join(root,'elsewhere'),path.join(root,'profile-saves/p_link'));assert.throws(()=>saves.remove('p_link'));assert.equal(fs.existsSync(path.join(root,'elsewhere')),true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('every host injects the player script after its own modules and before game scripts',()=>{
 const tag='<script data-handheld-system src="/runtime/core/game-shell.js"></script><script data-cubby-profile src="/runtime/core/profiles.js"></script>';
 for(const file of ['runtime/game_shell.py','desktop/main.cjs','runtime/core/browser-store.js'])assert.ok(fs.readFileSync(file,'utf8').includes(tag),file);
 const index=fs.readFileSync('runtime/index.html','utf8');
 assert.ok(index.indexOf('profiles.js')<index.indexOf('platform.js')&&index.indexOf('avatars.js')<index.indexOf('hub.js'));assert.doesNotMatch(index,/data-cubby-profile/,'The hub is never rescoped');
 assert.match(fs.readFileSync('desktop/build.cjs','utf8'),/runtime','core','profiles\.js'/,'The packaged desktop host carries the player rules');
});

// Names: the one word a child sees. Stored and checked only here, in the core rules.
test('player names are trimmed, short, made of letters, and never empty',()=>{
 const ok={'  Maya  ':'Maya','Mary   Ann':'Mary Ann','Anne-Marie':'Anne-Marie','O’Neil':"O’Neil","D'Angelo":"D'Angelo",'Zoë':'Zoë','José Luis':'José Luis','Jr.':'Jr.','abcdefghijkl':'abcdefghijkl','Zoë':'Zoë'};
 for(const [raw,clean] of Object.entries(ok))assert.equal(Profiles.cleanName(raw),clean,raw);
 for(const bad of ['','   ','abcdefghijklm','<b>Al</b>','Maya!','-Al','.Al',null,undefined,42,'😀','Al\u0000'])assert.throws(()=>Profiles.cleanName(bad),String(bad));
 assert.equal(Profiles.NAME_LENGTH,12);
});
test('names persist, default to the animal, and no two players share one',async()=>{
 const s=storage(),made=Profiles.createProfiles({storage:s,session:storage(),platform:{removeProfile:async()=>{}}});
 assert.equal(made.list()[0].name,'Cubby');made.claim('fox','Al');
 assert.equal(made.rename(FIRST,'  Theo '),'Theo');assert.equal(JSON.parse(s.getItem(Profiles.REGISTRY_KEY)).profiles[0].name,'Theo','Naming the only player writes it');
 const maya=made.add('bear','Maya'),bunny=made.add('bunny');
 assert.deepEqual(Profiles.createProfiles({storage:s}).list().map(p=>[p.name,p.named]),[['Theo',true],['Maya',true],['Bunny',false]],'Names survive a restart');
 for(const taken of ['theo','MAYA'])assert.throws(()=>made.rename(bunny.id,taken),/already used/,taken);assert.throws(()=>made.rename(maya.id,'bunny'),/already used/,'An animal name in use is taken');assert.equal(made.rename(maya.id,'MAYA'),'MAYA','A player may change their own name’s case');made.rename(maya.id,'Maya');
 assert.throws(()=>made.add('owl','Theo'),/already used/);assert.throws(()=>made.rename(bunny.id,''),/required/);
 made.rename(maya.id,'Bear');assert.equal(JSON.parse(s.getItem(Profiles.REGISTRY_KEY)).profiles[1].name,undefined,'Their own animal’s name is no name of their own');
 made.setAvatar(maya.id,'panda');assert.equal(made.list()[1].name,'Panda','A default name follows the picture');
 made.rename(bunny.id,'Owl');assert.throws(()=>made.setAvatar(maya.id,'owl'),/already used/,'A picture whose animal name is taken is refused');
 assert.throws(()=>made.add('owl'),/already used/);
 made.setAvatar(FIRST,'cat');assert.equal(made.list()[0].name,'Theo','A chosen name stays with a new picture');
 await made.remove(maya.id);assert.deepEqual(made.list().map(p=>p.name),['Theo','Owl']);
 assert.throws(()=>made.rename('p_missing','Al'),/Unknown/);
});
test('a damaged stored name falls back to the animal and keeps the player',()=>{
 const s=storage();players(s,[{id:FIRST,avatar:'bear',name:'Theo'},{id:'p_second1',avatar:'fox',name:'<script>'},{id:'p_third1',avatar:'owl',name:'x'.repeat(40)}]);
 assert.deepEqual(Profiles.createProfiles({storage:s}).list().map(p=>[p.id,p.name]),[[FIRST,'Theo'],['p_second1','Fox'],['p_third1','Owl']]);
});
test('animal names match the pictures',()=>{for(const id of Avatars.ids)assert.equal(Profiles.ANIMAL_NAMES[id],Avatars.name(id));});
