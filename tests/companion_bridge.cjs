'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {MessageChannel} = require('node:worker_threads');
const Host = require('../parents/companion-host.js');
const Client = require('../runtime/core/companion.js');
const tick = () => new Promise(r => setTimeout(r, 10));
function fixture() {
  const listeners = new Map(), calls = [], stateListeners = new Set(), messages = new Set();
  const peer = {id:'room-a',name:'Kitchen',confirmed:true,connected:true,players:[{id:'kid-a',name:'Fox'}],games:['game-a'],companions:[{id:'game-a',companion:{url:'https://game.example/parent/'}}]};
  const link = {pairings:() => [peer,{id:'room-b',confirmed:true,players:[]}],onChange(fn) {stateListeners.add(fn);return () => stateListeners.delete(fn);},channel(game) {calls.push(['channel',game]);return {send(body,target){calls.push(['send',body,target]);return 'message-id';},key(room,label){calls.push(['key',room,label]);return Promise.resolve(new Uint8Array([4,2]));},waiting(room){calls.push(['waiting',room]);return 2;},onMessage(fn){messages.add(fn);return () => messages.delete(fn);}};}};
  const win = {location:new URL('https://cubby.example/parents/'),MessageChannel,addEventListener(t,fn){listeners.set(t,fn);},removeEventListener(t,fn){if(listeners.get(t)===fn)listeners.delete(t);}};
  let childPort;
  const source = {postMessage(value,origin,ports){assert.equal(origin,'https://game.example');childPort=ports[0];}};
  const frame = {contentWindow:source};
  const host = Host.connect(win,{frame,link,game:'game-a',peer:'room-a',url:'https://game.example/parent/'});
  const hello = (overrides={}) => listeners.get('message')?.({source,origin:'https://game.example',data:{type:'cubby-companion-ready',version:1},...overrides});
  return {win,host,link,peer,calls,stateListeners,messages,hello,get port(){return childPort;},listeners};
}
test('one existing pairing supplies only its selected game and Cubby, with no pairing secrets', async () => {
  const f=fixture();f.hello();const api=Client.fromPort(f.port);const link=await api.ready;
  assert.equal(link.pairings().length,1);assert.equal(link.pairings()[0].id,'room-a');
  assert.equal(link.pairings()[0].companions,undefined);assert.equal(link.acceptPairing,undefined);assert.equal(link.removePairing,undefined);
  const line=link.channel('game-a');assert.throws(()=>link.channel('game-b'));
  assert.equal(await line.send({t:'ask'}),'message-id');
  assert.deepEqual(f.calls.find(c=>c[0]==='send')[2],{to:'room-a'});
  assert.deepEqual(Array.from(await line.key('room-a','coin:kid-a')),[4,2]);
  await assert.rejects(line.send({}, {to:'room-b'}));await assert.rejects(line.key('room-b','coin'));
  f.host.close();api.close();
});
test('bridge filters peer messages, pushes state without reloading, and tears down capabilities',async()=>{
  const f=fixture();f.hello();const api=Client.fromPort(f.port),link=await api.ready,line=link.channel('game-a'),received=[];
  line.onMessage(m=>received.push(m));let changes=0;link.onChange(()=>changes++);
  for(const fn of f.messages){fn({from:{id:'room-b'},body:{t:'wrong'}});fn({from:f.peer,player:'kid-a',body:{t:'state',coins:2}});}
  f.peer.connected=false;for(const fn of f.stateListeners)fn();await tick();
  assert.equal(received.length,1);assert.equal(received[0].body.coins,2);assert.equal(link.pairings()[0].connected,false);assert.ok(changes>0);
  f.host.close();await tick();await assert.rejects(line.send({t:'late'}));assert.equal(f.messages.size,0);assert.equal(f.stateListeners.size,0);api.close();
});
test('handshake rejects unrelated windows/origins and same-origin frames cannot obtain parent authority',()=>{
  const f=fixture();f.hello({origin:'https://evil.example'});assert.equal(f.port,undefined);f.hello({source:{}});assert.equal(f.port,undefined);f.host.close();
  assert.throws(()=>Host.connect(f.win,{frame:{},link:f.link,game:'game-a',peer:'room-a',url:'https://cubby.example/game/'}));
});
test('removing or replacing the advertised game revokes an open bridge',async()=>{
  const f=fixture();f.hello();const api=Client.fromPort(f.port),link=await api.ready;
  f.peer.companions=[];for(const fn of [...f.stateListeners])fn();await tick();
  await assert.rejects(link.channel('game-a').send({t:'ask'}));api.close();
});

test('messages received before the game subscribes are retained and old capability ports cannot send after close',async()=>{
  const f=fixture();f.hello();const api=Client.fromPort(f.port),link=await api.ready;
  for(const fn of f.messages) fn({from:f.peer,body:{t:'state',coins:1}});
  await tick();const received=[];link.channel('game-a').onMessage(m=>received.push(m));assert.equal(received.length,1);
  f.host.close();await tick();const before=f.calls.filter(c=>c[0]==='send').length;
  f.port.postMessage({id:999,op:'send',body:{t:'stale'}});await tick();assert.equal(f.calls.filter(c=>c[0]==='send').length,before);api.close();
});

test('standalone game companion does not start a pairing flow or transport',async()=>{
  const win={};win.parent=win;const client=Client.attach(win);assert.equal(client.embedded,false);assert.equal(await client.ready,null);
});
