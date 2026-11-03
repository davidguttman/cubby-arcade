const test=require('node:test'),assert=require('node:assert/strict');
const {startUpdateChecks}=require('../runtime/core/browser-store.js');
function target(){const listeners=new Map();return {addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},emit(name){for(const fn of [...listeners.get(name)||[]])fn();},count(){return [...listeners.values()].reduce((n,set)=>n+set.size,0);}};}
function fixture(){const document={...target(),hidden:false},timers=new Map(),calls=[];let next=0;const win={...target(),document,navigator:{onLine:true},setInterval(fn,ms){assert.equal(ms,300000);timers.set(++next,fn);return next;},clearInterval(id){timers.delete(id);}};const bridge={async checkUpdates(options){calls.push(options);}};return {win,bridge,calls,tick(){for(const fn of timers.values())fn();},timerCount:()=>timers.size};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('checks on mount, five-minute ticks, visible return and reconnect; skips hidden/offline',async()=>{
 const s=fixture(),stop=startUpdateChecks(s.win,s.bridge);await settle();assert.equal(s.calls.length,1);
 s.tick();await settle();assert.equal(s.calls.length,2);
 s.win.document.hidden=true;s.tick();s.win.document.emit('visibilitychange');await settle();assert.equal(s.calls.length,2);
 s.win.document.hidden=false;s.win.document.emit('visibilitychange');await settle();assert.equal(s.calls.length,3);
 s.win.navigator.onLine=false;s.tick();await settle();assert.equal(s.calls.length,3);
 s.win.navigator.onLine=true;s.win.emit('online');await settle();assert.equal(s.calls.length,4);stop();
});
test('overlapping triggers coalesce; pagehide aborts and removes timers/listeners',async()=>{
 const s=fixture();let resolve;s.bridge.checkUpdates=({signal})=>{s.calls.push({signal});return new Promise(r=>resolve=r);};
 const stop=startUpdateChecks(s.win,s.bridge);s.tick();s.win.emit('online');assert.equal(s.calls.length,1);
 s.win.emit('pagehide');assert.equal(s.calls[0].signal.aborted,true);assert.equal(s.timerCount(),0);assert.equal(s.win.count()+s.win.document.count(),0);
 resolve();await settle();s.tick();assert.equal(s.calls.length,1);stop();
});
