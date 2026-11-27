// A computer can have several controller-like devices: a second pad, a virtual pad from
// Steam or another program, a wheel, sometimes one that never sits still. Seen on Windows:
// the browser lists every pad from the start, so the one being played can be second.
const test=require('node:test'),assert=require('node:assert/strict');
const {createCalibration,createDevice}=require('../runtime/core/host-osd.js');
globalThis.HandheldPreferences=require('../runtime/core/preferences.js');
const {createInput}=require('../runtime/core/input.js');
const pad=(id,index)=>({id,index,mapping:'standard',connected:true,timestamp:0,buttons:Array.from({length:17},()=>({pressed:false,touched:false,value:0})),axes:[0,0,0,0]});
const hold=(p,...on)=>p.buttons.forEach((b,i)=>{b.pressed=on.includes(i);b.touched=b.pressed;b.value=b.pressed?1:0;});
function rig(pads){
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const cal=createCalibration(()=>pads,storage,()=>0),device=createDevice(()=>cal.getGamepads());
 const frames=[],got=[];let t=0;
 createInput({target:{addEventListener(){},removeEventListener(){}},document:null,navigator:{getGamepads:()=>device.getGamepads()},requestFrame:f=>frames.push(f),cancelFrame(){},
  onAction:a=>got.push(a.button),preferences:{get:()=>({keyboard:{}}),subscribe:()=>()=>{}}});
 const step=(n=1)=>{for(let i=0;i<n;i++){t+=16;frames.shift()?.(t);}};
 const tap=(p,i)=>{hold(p,i);step(2);hold(p);step(2);};
 return {cal,device,got,step,tap};
}
test('the pad being played is heard even when another pad is listed first',()=>{
 const idle=pad('Steam Virtual Gamepad',0),played=pad('Controller (Xbox One For Windows)',1);
 const r=rig([idle,played]);r.step(20);
 r.tap(played,0);r.tap(played,15);r.tap(played,14);
 assert.deepEqual(r.got,['a','right','left']);
});
test('the stick follows the pad that last pressed a button; a wandering device does not steer',()=>{
 const wandering=pad('Motion device',0),played=pad('Wireless Controller',1);
 const r=rig([wandering,played]);r.step(5);
 wandering.axes[0]=-1;r.step(5);
 r.tap(played,0);r.step(5);
 played.axes[0]=1;r.step(2);played.axes[0]=0;r.step(2);
 assert.ok(r.got.includes('right'),JSON.stringify(r.got));
 assert.ok(!r.got.slice(r.got.indexOf('a')).includes('left'),'the wandering device steered after the real pad took over: '+JSON.stringify(r.got));
});
test('setup takes A, B, X, Y from the second pad while the first never sits still, then the hub hears it',()=>{
 const wandering=pad('Motion device',0),played=pad('Wireless Controller',1);
 const r=rig([wandering,played]);r.step(5);
 let saved=null;r.cal.begin(s=>{if(s.phase==='saved')saved=s;});r.step(2);
 for(const i of [0,1,2,3]){wandering.axes[0]=wandering.axes[0]>0?-.9:.9;wandering.axes[1]=.8;r.tap(played,i);}
 assert.ok(saved,'setup finished');
 r.cal.cancel();r.step(3);
 assert.equal(r.cal.isBlocking(),false,'a device that never sits still must not hold input after setup');
 r.got.length=0;r.tap(played,0);r.tap(played,13);
 assert.deepEqual(r.got,['a','down']);
});
test('setup ignores a held button on another pad only after that pad lets go of it',()=>{
 const other=pad('Other',0),played=pad('Played',1);hold(other,0);
 const r=rig([other,played]);r.step(3);
 let state=null;r.cal.begin(s=>{state=s;});r.step(3);
 assert.equal(state.ready,false,'a button held when setup opens is not a capture');
 hold(other);r.step(2);r.tap(played,0);
 assert.deepEqual(state.captured,['A']);
});
