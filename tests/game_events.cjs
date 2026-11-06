const test=require('node:test'),assert=require('node:assert/strict');
const {install}=require('../runtime/core/game-shell.js');
const tick=()=>new Promise(done=>setImmediate(done));
function harness({protocol='http:',fetch}={}){
 const events={},timers=[];
 const doc={readyState:'complete',hidden:false,hasFocus:()=>true,createElement(){return {style:{},hidden:false,setAttribute(){},appendChild(){},addEventListener(){},focus(){},remove(){}};},body:{appendChild(){}}};
 const env={document:doc,navigator:{getGamepads:()=>[]},location:{pathname:'/games/demo/main.html',href:'',protocol},fetch,
  addEventListener(n,f){(events[n]??=[]).push(f);},removeEventListener(){},requestAnimationFrame(){return 1;},cancelAnimationFrame(){},
  dispatchEvent(e){(events[e.type]||[]).forEach(f=>f(e));},CustomEvent:class{constructor(type,o){this.type=type;this.detail=o?.detail;}},
  setTimeout(f,ms){timers.push({f,ms});return timers.length;},AbortController};
 return {env,timers,shell:install(env)};
}
// A scripted host: replies in order, then holds the last poll open like the real long poll.
function host(replies){
 const polls=[],acks=[];let hold=null;
 const fetch=async(url,options={})=>{
  if(url==='/api/system-events/ack'){acks.push(JSON.parse(options.body).seq);return {ok:true};}
  polls.push(url);
  const next=replies.shift();
  if(next===undefined)return new Promise((_,reject)=>{hold=reject;options.signal?.addEventListener('abort',()=>reject(new Error('aborted')));});
  if(next instanceof Error)throw next;
  return next.ok===false?next:{ok:true,json:async()=>next};
 };
 return {fetch,polls,acks,release:()=>hold?.(new Error('done'))};
}

test('games hear sleep and wake as window events, with the reason',async()=>{
 const h=host([{seq:0,events:[]},{seq:1,events:[{seq:1,type:'sleep',detail:{reason:'idle'}}]},{seq:2,events:[{seq:2,type:'wake',detail:{reason:'button'}}]}]);
 const {env,shell}=harness({fetch:h.fetch});const heard=[];
 env.addEventListener('handheld:sleep',e=>heard.push(['sleep',e.detail.reason]));
 env.addEventListener('handheld:wake',e=>heard.push(['wake',e.detail.reason]));
 for(let i=0;i<10;i++)await tick();
 assert.deepEqual(heard,[['sleep','idle'],['wake','button']]);
 assert.deepEqual(h.polls.slice(0,3),['/api/system-events?after=-1','/api/system-events?after=0','/api/system-events?after=1']);
 shell.dispose();
});
test('a game with no listeners acks straight away, so existing games add no delay',async()=>{
 const h=host([{seq:0,events:[]},{seq:1,events:[{seq:1,type:'sleep',detail:{}}]}]);
 const {shell}=harness({fetch:h.fetch});
 for(let i=0;i<10;i++)await tick();
 assert.deepEqual(h.acks,[1]);
 shell.dispose();
});
test('waitUntil holds the ack until the game finishes',async()=>{
 const h=host([{seq:0,events:[]},{seq:1,events:[{seq:1,type:'sleep',detail:{}}]}]);
 const {env,shell}=harness({fetch:h.fetch});let finish;
 env.addEventListener('handheld:sleep',e=>e.waitUntil(new Promise(done=>{finish=done;})));
 for(let i=0;i<10;i++)await tick();
 assert.deepEqual(h.acks,[]);
 finish();
 for(let i=0;i<10;i++)await tick();
 assert.deepEqual(h.acks,[1]);
 shell.dispose();
});
test('waitUntil is bounded, so a game that never finishes cannot hold up sleep',async()=>{
 const h=host([{seq:0,events:[]},{seq:1,events:[{seq:1,type:'sleep',detail:{}}]}]);
 const {env,timers,shell}=harness({fetch:h.fetch});
 env.addEventListener('handheld:sleep',e=>e.waitUntil(new Promise(()=>{})));
 for(let i=0;i<10;i++)await tick();
 assert.deepEqual(h.acks,[]);
 const limit=timers.find(t=>t.ms===1500);assert.ok(limit);limit.f();
 for(let i=0;i<10;i++)await tick();
 assert.deepEqual(h.acks,[1]);
 shell.dispose();
});
test('a rejected waitUntil or a listener that throws still lets sleep go ahead',async()=>{
 const h=host([{seq:0,events:[]},{seq:1,events:[{seq:1,type:'sleep',detail:{}}]}]);
 const {env,shell}=harness({fetch:h.fetch});
 env.addEventListener('handheld:sleep',e=>{e.waitUntil(Promise.reject(new Error('no')));throw new Error('broken game');});
 for(let i=0;i<10;i++)await tick();
 assert.deepEqual(h.acks,[1]);
 shell.dispose();
});
test('a page loaded later hears nothing old: it starts from where the stream is',async()=>{
 const h=host([{seq:7,events:[]}]);
 const {env,shell}=harness({fetch:h.fetch});const heard=[];
 env.addEventListener('handheld:sleep',()=>heard.push(1));
 for(let i=0;i<5;i++)await tick();
 assert.deepEqual(heard,[]);
 assert.equal(h.polls[1],'/api/system-events?after=7');
 shell.dispose();
});
test('hosts without the API stop asking',async()=>{
 const h=host([{ok:false,status:404}]);
 const {shell}=harness({fetch:h.fetch});
 for(let i=0;i<10;i++)await tick();
 assert.equal(h.polls.length,1);
 shell.dispose();
});
test('network errors retry, then give up',async()=>{
 const h=host([1,2,3,4,5,6].map(()=>new Error('down')));
 const {timers,shell}=harness({fetch:h.fetch});
 for(let round=0;round<8;round++){for(let i=0;i<5;i++)await tick();timers.filter(t=>t.ms===2000).splice(0).forEach(t=>{t.ms=0;t.f();});}
 assert.equal(h.polls.length,5);
 shell.dispose();
});
test('non-http hosts do not poll, and can deliver events directly',async()=>{
 const h=host([]);
 const {env,shell}=harness({protocol:'hub:',fetch:h.fetch});const heard=[];
 env.addEventListener('handheld:wake',e=>heard.push(e.detail.reason));
 await tick();
 assert.equal(h.polls.length,0);
 await shell.systemEvent('wake',{reason:'system'});
 assert.deepEqual(heard,['system']);
 shell.dispose();
});
test('disposing the page stops the long poll',async()=>{
 const h=host([{seq:0,events:[]}]);
 const {shell}=harness({fetch:h.fetch});
 for(let i=0;i<5;i++)await tick();
 const before=h.polls.length;
 shell.dispose();
 for(let i=0;i<5;i++)await tick();
 assert.equal(h.polls.length,before);
});
