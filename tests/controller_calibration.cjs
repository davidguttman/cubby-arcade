const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createCalibration,createDevice,controllerKey}=require('../runtime/core/host-osd.js');
const storageKey='cubby:controller-labels:v1';
function makePad(id='Xbox 360 Controller (Steam Virtual Gamepad)',index=0,mapping='standard'){return {id,index,mapping,connected:true,buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]};}
function fixture(id){
 const pad=makePad(id),pads=[pad];let time=0;
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const read=()=>pads,cal=createCalibration(read,storage,()=>time);
 const hold=(target,...indices)=>target.buttons.forEach((b,i)=>{b.pressed=indices.includes(i);b.value=b.pressed?1:0;});
 const press=(...indices)=>{hold(pad,...indices);return cal.getGamepads();};
 const steps=[];const begin=()=>cal.begin(step=>steps.push(step));
 return {pad,pads,values,storage,read,cal,press,hold,steps,begin,advance:ms=>{time+=ms;}};
}
// The whole adult flow, from a pad alone: release, then A, B, X, Y as printed.
function calibrate(f,sources=[1,0,3,2]){f.begin();for(const index of sources){f.press();f.press(index);}f.cal.cancel();f.press();}
test('pad alone: A, B, X, Y save automatically, remap raw Gamepad consumers, and persist per reported identity',()=>{
 const f=fixture();f.begin();assert.equal(f.cal.state().next,'A');
 for(const [i,index] of [1,0,3,2].entries()){f.press();assert.equal(f.cal.state().next,'ABXY'[i]);f.press(index);}
 const last=f.steps.at(-1);assert.equal(last.phase,'saved');assert.equal(last.persisted,true);assert.deepEqual(last.captured,['A','B','X','Y']);
 assert.deepEqual(JSON.parse(f.values.get(storageKey)),{[controllerKey(f.pad)]:[1,0,3,2]});
 f.cal.cancel();f.press();let pads=f.press(1);assert.equal(pads[0].buttons[0].pressed,true);assert.equal(pads[0].buttons[1].pressed,false);
 const restored=createCalibration(f.read,f.storage);assert.equal(restored.getGamepads()[0].buttons[0].pressed,true);
 f.pad.id='different controller';assert.equal(restored.getGamepads()[0].buttons[1].pressed,true);
});
test('profiles saved by the earlier calibration screen keep working',()=>{
 const f=fixture();f.values.set(storageKey,JSON.stringify({[JSON.stringify([f.pad.id,'standard',17,4])]:[1,0,3,2]}));
 const cal=createCalibration(f.read,f.storage);f.hold(f.pad,1);assert.equal(cal.getGamepads()[0].buttons[0].pressed,true);
});
test('the press that opened setup is not captured; everything must be released first',()=>{
 const f=fixture();f.press(0);f.begin();assert.equal(f.cal.state().ready,false);
 f.press(0);assert.equal(f.cal.state().next,'A');assert.deepEqual(f.cal.state().captured,[]);
 f.press();assert.equal(f.cal.state().ready,true);f.press(1);assert.equal(f.cal.state().next,'B');
});
test('capture swallows all input, waits for releases, and rejects simultaneous and duplicate presses',()=>{
 const f=fixture();f.begin();
 assert.equal(f.press(1)[0].buttons.some(b=>b.pressed),false);assert.equal(f.cal.state().next,'A');
 f.press();f.press(0,1);assert.equal(f.cal.state().next,'A');assert.equal(f.cal.state().rejected,1);
 f.press(1);assert.equal(f.cal.state().next,'A','held after a rejection is not a new press');
 f.press();f.press(1);assert.equal(f.cal.state().next,'B');f.press(0);assert.equal(f.cal.state().next,'B');
 f.press();f.press(1);assert.equal(f.cal.state().rejected,2);assert.equal(f.cal.state().next,'B');
 f.pad.axes[0]=1;f.press();assert.equal(f.cal.state().ready,false,'a held stick is not released');f.pad.axes[0]=0;
 f.press();f.press(0);assert.equal(f.cal.state().next,'X');
});
test('the first pad to press is calibrated; other pads cannot take over',()=>{
 const f=fixture(),second=makePad('Second pad',1);f.pads.push(second);f.begin();
 f.press();f.hold(second,2);f.cal.getGamepads();f.hold(second);assert.equal(f.cal.state().next,'B');
 f.press();f.press(2);assert.equal(f.cal.state().next,'B','an unlocked pad is ignored');
 for(const index of [3,1,0]){f.press();f.hold(second,index);f.cal.getGamepads();f.hold(second);}
 assert.equal(f.steps.at(-1).phase,'saved');assert.deepEqual(JSON.parse(f.values.get(storageKey)),{[controllerKey(second)]:[2,3,1,0]});
});
test('pressing A, B, X, Y onto their default buttons removes the profile instead of storing one',()=>{
 const f=fixture();calibrate(f);assert.equal(Object.keys(JSON.parse(f.values.get(storageKey))).length,1);
 calibrate(f,[0,1,2,3]);assert.deepEqual(JSON.parse(f.values.get(storageKey)),{});
 f.press(1);assert.equal(f.cal.getGamepads()[0].buttons[1].pressed,true);
});
test('Start or any non-face button on a standard pad exits without changing the profile',()=>{
 for(const exit of [9,8,12,4]){
  const f=fixture();calibrate(f);const before=f.values.get(storageKey);
  f.begin();f.press();f.press(0);f.press();f.press(exit);
  assert.equal(f.steps.at(-1).phase,'cancelled');assert.equal(f.values.get(storageKey),before);
  f.cal.cancel();assert.equal(f.press(exit)[0].buttons.some(b=>b.pressed),false,'held exit press drains');
  f.press();assert.equal(f.press(1)[0].buttons[0].pressed,true,'original profile kept');
 }
});
test('a nonstandard pad may report a face button anywhere, so its buttons are captured, not exits',()=>{
 const f=fixture();f.pad.mapping='';f.begin();
 for(const index of [8,9,6,7]){f.press();f.press(index);}assert.equal(f.steps.at(-1).phase,'saved');f.cal.cancel();f.press();f.press(8);
 const pad=createDevice(()=>f.cal.getGamepads()).getGamepads()[0];assert.equal(pad.mapping,'standard');assert.equal(pad.buttons[0].pressed,true);assert.equal(pad.buttons[8].pressed,false);
});
test('ten seconds without input exits; any held control counts as input',()=>{
 const f=fixture();f.begin();f.press();f.advance(9000);f.press(0);f.advance(9000);f.press(0);f.advance(9000);f.press();
 assert.equal(f.cal.state().phase,'capture');assert.deepEqual(f.cal.state().captured,['A']);
 f.advance(1000);f.press();assert.equal(f.steps.at(-1).phase,'timeout');assert.equal(f.values.get(storageKey),undefined);
 assert.equal(f.cal.isBlocking(),true,'blocked until the hub closes setup');f.cal.cancel();f.press();assert.equal(f.cal.isBlocking(),false);
});
test('cancel and save never leak held capture buttons or axes into navigation',()=>{
 const f=fixture();f.begin();f.press();f.press(1);f.pad.axes[0]=1;f.cal.cancel();
 let pad=f.press(1)[0];assert.equal(pad.buttons.some(b=>b.pressed),false);assert.equal(pad.axes[0],0);
 f.press();assert.equal(f.press(1)[0].buttons.some(b=>b.pressed),false,'held stick still blocks');
 f.pad.axes[0]=0;f.press();assert.equal(f.press(1)[0].buttons[1].pressed,true,'cancel stores nothing');
 f.begin();for(const index of [1,0,3]){f.press();f.press(index);}f.press();f.press(2);
 assert.equal(f.press(2)[0].buttons.some(b=>b.pressed),false,'saved, still open');f.cal.cancel();
 assert.equal(f.press(2)[0].buttons.some(b=>b.pressed),false,'final Y drains after close');f.press();assert.equal(f.press(1)[0].buttons[0].pressed,true);
});
test('virtual OSD buttons merge after physical mapping and are never swapped twice',()=>{
 const f=fixture();calibrate(f);const device=createDevice(()=>f.cal.getGamepads());device.press(42,'a');f.press(0);
 let buttons=device.getGamepads()[0].buttons;assert.equal(buttons[0].pressed,true);assert.equal(buttons[1].pressed,true);
 device.release(42);f.press(1);buttons=device.getGamepads()[0].buttons;assert.equal(buttons[0].pressed,true);assert.equal(buttons[1].pressed,false);
});
test('invalid stored profiles are ignored; storage denial is reported instead of claiming persistence',()=>{
 const f=fixture(),key=controllerKey(f.pad);f.values.set(storageKey,JSON.stringify({[key]:[1,1,0,2]}));f.press(1);
 assert.equal(createCalibration(f.read,f.storage).getGamepads()[0].buttons[1].pressed,true);
 let last;const denied=createCalibration(f.read,{getItem(){throw Error('denied');},setItem(){throw Error('denied');}});denied.begin(step=>last=step);
 for(const index of [1,0,3,2]){f.hold(f.pad);denied.getGamepads();f.hold(f.pad,index);denied.getGamepads();}
 assert.equal(last.phase,'saved');assert.equal(last.persisted,false);denied.cancel();f.hold(f.pad);denied.getGamepads();f.hold(f.pad,1);assert.equal(denied.getGamepads()[0].buttons[0].pressed,true,'applies for this page');
});
test('host installs persistent mapping while OSD hidden, on hub and game paths, before raw consumers',()=>{
 const f=fixture();calibrate(f);
 for(const pathname of ['/','/games/demo/play.html']){
  const doc={readyState:'loading',addEventListener(){},removeEventListener(){},documentElement:{removeAttribute(){}}};
  const win={location:{pathname},document:doc,navigator:{getGamepads:f.read},localStorage:f.storage,addEventListener(){},removeEventListener(){},HandheldPreferences:{preferences:{showTouchControls:()=>false,subscribe:()=>()=>{}}}};
  const osd=require('../runtime/core/host-osd.js').install(win);f.hold(f.pad,1);assert.equal(win.navigator.getGamepads()[0].buttons[0].pressed,true);
  osd.device.press(42,'b');assert.equal(win.navigator.getGamepads()[0].buttons[1].pressed,true);osd.dispose();
 }
});
test('RG353V adapter remains default mapping; calibrated host reads adapter output without double swapping',()=>{
 const f=fixture('Sony Interactive Entertainment DualSense Wireless Controller'),win={navigator:{getGamepads:f.read}};require('../rocknix/gamepad.js').install(win);
 const cal=createCalibration(()=>win.navigator.getGamepads(),f.storage);f.hold(f.pad,1);assert.equal(cal.getGamepads()[0].buttons[0].pressed,true);
 cal.begin(()=>{});for(const index of [1,0,3,2]){f.hold(f.pad);cal.getGamepads();f.hold(f.pad,index);cal.getGamepads();}assert.equal(cal.state().phase,'saved');
 assert.deepEqual(JSON.parse(f.values.get(storageKey)),{},'adapter output is already A, B, X, Y: no profile');
 cal.cancel();f.hold(f.pad);cal.getGamepads();f.hold(f.pad,1);
 assert.equal(cal.getGamepads()[0].buttons[0].pressed,true);assert.equal(cal.getGamepads()[0].buttons[1].pressed,false);
});
test('shared host provider installs before hub input as well as delivered immutable games',()=>{
 const hub=fs.readFileSync('runtime/index.html','utf8');assert.ok(hub.indexOf('host-osd.js')>0);assert.ok(hub.indexOf('host-osd.js')<hub.indexOf('input.js'));
 const source=fs.readFileSync('runtime/core/host-osd.js','utf8'),installed=[];
 for(const pathname of ['/','/games/demo/play.html','/__cubby_games__/demo/play.html']){
  // Exercise browser bootstrap without a DOM: replace installation with a spy.
  const patched=source.replace('root.HandheldOSD=api.install(root)','root.HandheldOSD=installed.push(root.location.pathname)');
  vm.runInNewContext(patched,{location:{pathname},installed});
 }
 assert.equal(installed.length,3);
 const worker=fs.readFileSync('runtime/core/browser-store.js','utf8'),desktop=fs.readFileSync('desktop/main.cjs','utf8');
 for(const delivery of [worker,desktop])assert.ok(delivery.indexOf('host-osd.js')<delivery.indexOf('game-shell.js'));
});
