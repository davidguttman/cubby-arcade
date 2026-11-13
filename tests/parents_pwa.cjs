'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const root = require('node:path').join(__dirname, '..');
const read = p => fs.readFileSync(root + '/' + p);
function worker() {
  const events = {}, stores = new Map(), fetched = [];
  const caches = {async open(name) { if (!stores.has(name)) stores.set(name, new Map()); const map = stores.get(name); return {
    async addAll(paths) { for (const path of paths) map.set(path, new Response(path)); },
    async put(path, response) { map.set(path, response); }, async match(path) { return map.get(path)?.clone(); }
  }; }, async keys() { return [...stores.keys()]; }, async delete(name) { return stores.delete(name); }};
  let offline = false;
  const self = {location: new URL('https://cubby.example/parents/worker.js'), addEventListener: (type, fn) => { events[type] = fn; },
    clients: {claim: async () => {}}, skipWaiting: async () => {}};
  vm.runInNewContext(read('parents/worker.js').toString(), {self, caches, URL, fetch: async request => { fetched.push(request); if (offline) throw Error('offline'); return new Response('fresh'); }});
  return {events, caches, stores, fetched, offline() { offline = true; }};
}
test('manifest has scoped stable launch and real correctly sized regular/maskable/Apple PNGs', () => {
  const manifest = JSON.parse(read('parents/manifest.webmanifest'));
  assert.equal(manifest.start_url, '/parents/'); assert.equal(manifest.scope, '/parents/'); assert.equal(manifest.id, '/parents/');
  assert.equal(manifest.display, 'standalone');
  for (const [file, size] of [['icons/icon-192.png',192], ['icons/icon-512.png',512], ['icons/maskable-512.png',512], ['icons/apple-touch-icon.png',180]]) {
    const png = read('parents/' + file); assert.equal(png.toString('ascii', 1, 4), 'PNG'); assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  }
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'));
  const html = read('parents/index.html').toString(); assert.match(html, /rel="manifest"/); assert.match(html, /rel="apple-touch-icon"/);
});
test('worker serves normalized companion shell offline without hijacking games, catalogs, relay or play', async () => {
  const w = worker(); let pending;
  w.events.install({waitUntil: p => { pending = p; }}); await pending;
  for (const path of ['/parents/game/', '/catalog', '/beta/catalog', '/play/', '/parents/parents.js?pair=secret']) {
    let intercepted = false; w.events.fetch({request: {method:'GET',url:'https://cubby.example'+path,mode:'navigate'}, respondWith() { intercepted = true; }}); assert.equal(intercepted, false, path);
  }
  w.events.fetch({request:{method:'GET',url:'https://relay.example/parents/',mode:'navigate'},respondWith() { assert.fail('cross origin'); }});
  w.offline();
  let result; w.events.fetch({request:{method:'GET',url:'https://cubby.example/parents/?tracking=x',mode:'navigate'},respondWith(p) { result = p; }});
  assert.equal(await (await result).text(), '/parents/');
  assert.ok([...w.stores.values()].every(store => [...store.keys()].every(k => !k.includes('?') && !k.includes('#'))));
  let link; w.events.fetch({request:{method:'GET',url:'https://cubby.example/runtime/core/link.js',mode:'cors'},respondWith(p) { link = p; }});
  assert.equal(await (await link).text(), '/runtime/core/link.js');
});
test('worker uses fresh shell online and deletes only its own obsolete caches', async () => {
  const w = worker(); let pending;
  w.events.install({waitUntil: p => { pending = p; }}); await pending;
  await w.caches.open('cubby-parents-old'); await w.caches.open('cubby-browser-games');
  w.events.activate({waitUntil: p => { pending = p; }}); await pending;
  assert.equal(w.stores.has('cubby-parents-old'), false); assert.equal(w.stores.has('cubby-browser-games'), true);
  let result; w.events.fetch({request:{method:'GET',url:'https://cubby.example/parents/parents.js',mode:'cors'},respondWith(p) { result = p; }});
  assert.equal(await (await result).text(), 'fresh');
});
function installPage({ios = false, standalone = false, online = true} = {}) {
  const events = {}, elements = {}, registration = [];
  for (const id of ['install-card','install-button','install-help','offline-note']) elements[id] = {hidden: true, addEventListener(type, fn) { this[type] = fn; }};
  const display = {matches:standalone,addEventListener() {}}, navigator = {onLine:online,userAgent:ios?'iPhone':'Android',serviceWorker:{register(...args) { registration.push(args); return Promise.resolve(); }}};
  const window = {document:{getElementById: id => elements[id]},navigator,isSecureContext:true,matchMedia:() => display,addEventListener(type, fn) { events[type] = fn; }};
  vm.runInNewContext(read('parents/install.js').toString(), {window});
  return {events,elements,navigator,registration};
}
test('installation defers the browser prompt to a tap and leaves manual help after decline', async () => {
  const p = installPage(); let prevented = false, prompts = 0;
  const event = {preventDefault() { prevented = true; },async prompt() { prompts++; },userChoice:Promise.resolve({outcome:'dismissed'})};
  p.events.beforeinstallprompt(event); assert.equal(prevented,true); assert.equal(prompts,0); assert.equal(p.elements['install-button'].hidden,false);
  await p.elements['install-button'].click(); assert.equal(prompts,1); assert.equal(p.elements['install-help'].hidden,false);
  p.events.load(); assert.equal(p.registration[0][0],'worker.js'); assert.equal(p.registration[0][1].scope,'/parents/');
  p.events.appinstalled(); p.events.online(); assert.equal(p.elements['install-card'].hidden,true);
});
test('standalone hides installation; iOS explains Share and offline state follows connectivity', () => {
  assert.equal(installPage({standalone:true}).elements['install-card'].hidden,true);
  const p = installPage({ios:true,online:false}); assert.match(p.elements['install-help'].textContent,/Share.*Add to Home Screen/); assert.equal(p.elements['offline-note'].hidden,false);
  p.navigator.onLine=true; p.events.online(); assert.equal(p.elements['offline-note'].hidden,true);
});
test('installed app can consume a pasted trusted pairing link, rejecting arbitrary sites and relay URLs', () => {
  const window = {location:{origin:'https://preview.example',pathname:'/parents/',hash:'',search:''},localStorage:{getItem() { return null; }},CubbyLinkAPI:require('../runtime/core/link.js')};
  vm.runInNewContext(read('parents/pairing.js').toString(), {window,URL,URLSearchParams,navigator:{userAgent:'iPhone'}});
  const parse = window.CubbyParsePairingLink, code = 'a'.repeat(22);
  assert.equal(parse('https://cubbyarcade.com/parents/#pair='+code).code,code);
  assert.equal(parse('https://preview.example/parents/#pair='+code+'&relay=https%3A%2F%2Frelay.example').relay,'https://relay.example');
  for (const link of ['https://evil.example/parents/#pair='+code,'https://cubbyarcade.com/parents/game/#pair='+code,'https://cubbyarcade.com/parents/#pair=bad','https://cubbyarcade.com/parents/#pair='+code+'&relay=javascript%3Aalert(1)']) assert.throws(() => parse(link));
});
async function companionPage(pairings = [], catalog = []) {
  function node(tag) { return {tag,children:[],textContent:'',listeners:{},appendChild(child) { this.children.push(child); },replaceChildren() { this.children=[]; },setAttribute() {},addEventListener(type,fn) { this.listeners[type]=fn; }}; }
  const app=node('div'), accepted=[], answers=[];
  const link={pairings:() => pairings,onChange() {},async acceptPairing(code) { accepted.push(code); pairings.push({id:'second',name:'Second Cubby',confirmed:false,players:[]}); }};
  const window={document:{getElementById:() => app,createElement:node},location:{origin:'https://preview.example',pathname:'/parents/',hash:'',search:''},localStorage:{getItem() { return null; }},CubbyLinkAPI:require('../runtime/core/link.js'),CubbyLink:{ready:Promise.resolve(link)},prompt:() => answers.shift()};
  vm.runInNewContext(read('parents/pairing.js').toString(),{window,URL,URLSearchParams,navigator:{userAgent:'iPhone'}});
  vm.runInNewContext(read('parents/parents.js').toString(),{window,fetch:async () => ({ok:true,json:async () => catalog})});
  await new Promise(resolve => setImmediate(resolve));
  const all = (parent=app) => [parent,...parent.children.flatMap(child => all(child))];
  return {app,all,accepted,answers,pairings,paste:() => all().find(n => n.tag==='button' && n.textContent==='Paste pairing link')};
}
test('paste action adds a second Cubby and invalid input keeps existing pairings visible', async () => {
  const p=await companionPage([{id:'first',name:'First Cubby',confirmed:true,players:[]}]);
  assert.ok(p.paste(),'paired view offers pairing another Cubby');
  p.answers.push('https://cubbyarcade.com/parents/#pair='+'a'.repeat(22));
  await p.paste().listeners.click();
  assert.deepEqual(p.accepted,['a'.repeat(22)]);
  assert.ok(p.all().some(n => n.textContent==='First Cubby')); assert.ok(p.all().some(n => n.textContent==='Second Cubby'));
  p.answers.push('https://evil.example/parents/#pair='+'a'.repeat(22));
  await p.paste().listeners.click();
  assert.equal(p.pairings.length,2); assert.equal(p.accepted.length,1);
  assert.ok(p.all().some(n => n.textContent==='First Cubby'),'invalid paste does not replace paired view');
  assert.ok(p.all().some(n => n.textContent.includes('couldn’t be used')));
  assert.ok(p.paste(),'invalid input can be retried');
});
test('unpaired paste control explains copying fresh camera preview before opening', async () => {
  const p=await companionPage(); assert.ok(p.paste());
  assert.ok(p.all().some(n => /camera.*before opening/i.test(n.textContent)));
  p.answers.push('https://cubbyarcade.com/parents/#pair='+'a'.repeat(22)); await p.paste().listeners.click();
  assert.deepEqual(p.accepted,['a'.repeat(22)]);
});


test('installed game controls live inside their own Cubby card and carry that pairing', async () => {
  const p = await companionPage([
    {id:'lex-room',name:'Lex',confirmed:true,connected:true,players:[],games:['good-bribes-only']},
    {id:'fox-room',name:'Fox',confirmed:true,connected:false,players:[],games:[]},
    {id:'old-room',name:'Older Cubby',confirmed:true,connected:true,players:[]}
  ], [{id:'good-bribes-only',title:'Good Bribes Only',artwork:'coin.png',parents:'https://game.example/parent/'},
      {id:'uninstalled',title:'Uninstalled',artwork:'other.png',parents:'https://game.example/parent/'}]);
  const cards=p.app.children.filter(n=>n.className==='card');
  const anchors = card => p.all(card).filter(n=>n.tag==='a');
  assert.deepEqual(anchors(cards[0]).map(n=>n.href),['good-bribes-only/?cubby=lex-room']);
  assert.equal(anchors(cards[1]).length,0);
  assert.ok(p.all(cards[1]).some(n=>n.textContent==='No installed games with grown-up controls.'));
  assert.equal(anchors(cards[2]).length,0);
  assert.ok(p.all(cards[2]).some(n=>n.textContent.includes('update Cubby')));
  assert.ok(!p.all().some(n=>n.textContent==='Uninstalled'));
});
