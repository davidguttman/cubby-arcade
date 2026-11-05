const test=require('node:test'),assert=require('node:assert/strict');
const {startBattery}=require('../runtime/core/hub.js');
function fixture(profile='rg353v'){
 const tasks=new Map();let sequence=0,calls=0,payload={available:true,level:73,charging:false},fail=false;
 const node={hidden:false,dataset:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;}};
 const win={CubbyDeviceProfile:profile,AbortController,setTimeout(fn){const id=++sequence;tasks.set(id,fn);return id;},clearTimeout(id){tasks.delete(id);},fetch:async()=>{calls++;if(fail)throw Error('offline');return {ok:true,json:async()=>payload};}};
 return {node,win,tasks,set value(v){payload=v;},set fail(v){fail=v;},get calls(){return calls;},async tick(){const [id,fn]=[...tasks].at(-1);tasks.delete(id);await fn();}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('battery stays hidden and makes no requests outside the device host',async()=>{
 const f=fixture(undefined);f.win.CubbyDeviceProfile=undefined;const stop=startBattery(f.node,f.win);await settle();assert.equal(f.node.hidden,true);assert.equal(f.calls,0);assert.equal(f.tasks.size,0);stop();
});
test('device indicator reflects real level, low charge and charging without focusable UI',async()=>{
 const f=fixture(),stop=startBattery(f.node,f.win);await settle();
 assert.equal(f.node.hidden,false);assert.match(f.node.innerHTML,/width="13.14"/);assert.doesNotMatch(f.node.innerHTML,/<button|tabindex/);assert.equal(f.node.dataset.low,'false');
 f.value={available:true,level:12,charging:true};await f.tick();assert.equal(f.node.dataset.low,'true');assert.match(f.node.innerHTML,/battery-bolt/);assert.match(f.node.attributes['aria-label'],/Charging/);
 f.value={available:true,level:0,charging:false};await f.tick();assert.equal(f.node.hidden,false);assert.equal(f.node.dataset.low,'true');
 stop();assert.equal(f.tasks.size,0);
});
test('unavailable, invalid data and request failures hide stale battery information',async()=>{
 const f=fixture(),stop=startBattery(f.node,f.win);await settle();
 for(const value of [{available:false},{available:true,level:101,charging:false},{available:true,level:'4',charging:true},{available:true,level:30,charging:'yes'}]){f.value=value;await f.tick();assert.equal(f.node.hidden,true);}
 f.value={available:true,level:98,charging:false};await f.tick();assert.equal(f.node.hidden,false);
 f.fail=true;await f.tick();assert.equal(f.node.hidden,true);stop();assert.equal(f.tasks.size,0);
});
test('dispose aborts a pending request and ignores a late response',async()=>{
 const f=fixture();let finish,signal;
 f.win.fetch=(_url,options)=>{signal=options.signal;return new Promise(resolve=>finish=resolve);};
 const stop=startBattery(f.node,f.win);stop();assert.equal(signal.aborted,true);finish({ok:true,json:async()=>({available:true,level:50,charging:false})});await settle();assert.equal(f.node.hidden,true);assert.equal(f.tasks.size,0);
});
test('a timed-out read hides stale data and schedules a later recovery',async()=>{
 const f=fixture();let aborted=false;
 f.win.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));}));
 const stop=startBattery(f.node,f.win),[deadline,abort]=[...f.tasks][0];
 f.tasks.delete(deadline);abort();await settle();assert.equal(aborted,true);assert.equal(f.node.hidden,true);assert.equal(f.tasks.size,1);
 f.win.fetch=async()=>({ok:true,json:async()=>({available:true,level:50,charging:false})});
 await f.tick();assert.equal(f.node.hidden,false);stop();assert.equal(f.tasks.size,0);
});
