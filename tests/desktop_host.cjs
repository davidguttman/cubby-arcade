const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {assetPath,gameScope,requireHubFrame,SaveStore,GameLibrary}=require('../desktop/host.cjs');
test('desktop protocol confines assets and sender game scope',()=>{
  assert.equal(assetPath('hub://app/games/demo/index.html','/tmp/site'),'/tmp/site/games/demo/index.html');
  assert.equal(assetPath('hub://app/runtime/core/preferences.js','/tmp/site'),'/tmp/site/runtime/core/preferences.js');
  for(const url of ['https://evil/index.html','hub://evil/index.html','hub://app/%2e%2e/%2fetc/passwd','hub://app/foo%00'])assert.throws(()=>assetPath(url,'/tmp/site'));
  assert.equal(gameScope('hub://app/games/demo/play.html'),'demo');
  assert.throws(()=>gameScope('hub://app/'));assert.throws(()=>gameScope('https://app/games/demo/'));
});
test('managed disk library overrides bundled demo and removal never resurrects it',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-library-'));
  try{
    const site=path.join(root,'web'),games=path.join(root,'games');fs.mkdirSync(site);
    fs.writeFileSync(path.join(site,'library'),JSON.stringify([{id:'bundled'}]));
    const library=new GameLibrary(site,games);
    assert.deepEqual(library.entries(),[{id:'bundled'}]);
    fs.mkdirSync(games);assert.deepEqual(library.entries(),[]);
    const release=path.join(games,'test-game/releases/1');fs.mkdirSync(release,{recursive:true});
    fs.writeFileSync(path.join(release,'index.html'),'game');
    fs.writeFileSync(path.join(release,'art.svg'),'art');
    const sha=require('node:crypto').createHash('sha256').update('game').digest('hex');
    fs.writeFileSync(path.join(release,'manifest.json'),JSON.stringify({schema_version:1,runtime:'web',id:'test-game',version:'1',entrypoint:'index.html',artwork:'art.svg',files:{'index.html':sha,'art.svg':sha}}));
    fs.symlinkSync('releases/1',path.join(games,'test-game/current'));
    assert.equal(library.entries()[0].id,'test-game');
    assert.equal(library.file('hub://app/games/test-game/index.html'),path.join(release,'index.html'));
    assert.throws(()=>library.file('hub://app/games/test-game/manifest.json'));
    assert.throws(()=>library.file('hub://app/games/bundled/index.html'));
    fs.unlinkSync(path.join(games,'test-game/current'));assert.deepEqual(library.entries(),[]);
    assert.throws(()=>library.file('hub://app/games/test-game/index.html'));
    assert.throws(()=>library.file('hub://app/games/test-game/%2e%2e/secret'));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('disk saves persist per game and reject traversal or oversized values',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-save-'));
  try {
    const store=new SaveStore(root);store.set('one','run',{level:3});
    assert.deepEqual(new SaveStore(root).get('one','run'),{level:3});assert.equal(store.get('two','run'),null);
    assert.throws(()=>store.set('../bad','run',1));assert.throws(()=>store.get('one','../../bad'));
    assert.throws(()=>store.set('one','huge','x'.repeat(1024*1024+1)));
    assert.deepEqual(store.get('one','run'),{level:3});store.remove('one','run');assert.equal(store.get('one','run'),null);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('native hub controls reject game pages, foreign origins and subframes',()=>{
 const main={url:'hub://app/'};const sender={mainFrame:main};
 assert.doesNotThrow(()=>requireHubFrame({sender,senderFrame:main}));
 main.url='hub://app/index.html';assert.doesNotThrow(()=>requireHubFrame({sender,senderFrame:main}));
 for(const url of ['hub://app/games/demo/play.html','https://app/','hub://other/','hub://app/runtime/core/hub.js']){main.url=url;assert.throws(()=>requireHubFrame({sender,senderFrame:main}));}
 assert.throws(()=>requireHubFrame({sender,senderFrame:{url:'hub://app/'}}));
});
