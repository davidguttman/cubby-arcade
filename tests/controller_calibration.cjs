const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createCalibration,createDevice}=require('../runtime/core/host-osd.js');
function fixture(id='Xbox 360 Controller (Steam Virtual Gamepad)'){
 const pad={id,index:0,mapping:'standard',connected:true,buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]};
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 const read=()=>[pad],cal=createCalibration(read,storage);
 const press=(...indices)=>{pad.buttons.forEach((b,i)=>{b.pressed=indices.includes(i);b.value=b.pressed?1:0;});return cal.getGamepads();};
 return {pad,storage,read,cal,press};
}
function calibrate(f){f.cal.begin(f.cal.controllers()[0].key);for(const index of [1,0,3,2]){f.press();f.press(index);}f.cal.save();f.press();}
test('Nintendo labels through a Steam Xbox identity remap raw Gamepad consumers and persist per reported identity',()=>{
 const f=fixture();calibrate(f);let pads=f.press(1);assert.equal(pads[0].buttons[0].pressed,true);assert.equal(pads[0].buttons[1].pressed,false);
 const restored=createCalibration(f.read,f.storage);assert.equal(restored.getGamepads()[0].buttons[0].pressed,true);
 f.pad.id='different controller';assert.equal(restored.getGamepads()[0].buttons[1].pressed,true);
});
test('calibration suppresses all input, waits for releases, rejects simultaneous and duplicate captures',()=>{
 const f=fixture();f.press(1);f.cal.begin(f.cal.controllers()[0].key);
 assert.equal(f.press(1)[0].buttons.some(b=>b.pressed),false);assert.equal(f.cal.state().next,'A');
 f.press();f.press(0,1);assert.equal(f.cal.state().next,'A');f.press(1);assert.equal(f.cal.state().next,'A');
 f.press();f.press(1);assert.equal(f.cal.state().next,'B');f.press(0);assert.equal(f.cal.state().next,'B');
 f.press();f.press(1);assert.match(f.cal.state().message,/already/);assert.equal(f.cal.state().next,'B');
});
test('cancel and save never leak held capture buttons or axes into navigation',()=>{
 const f=fixture();f.cal.begin(f.cal.controllers()[0].key);f.press();f.press(1);f.pad.axes[0]=1;f.cal.cancel();
 let pad=f.press(1)[0];assert.equal(pad.buttons.some(b=>b.pressed),false);assert.equal(pad.axes[0],0);
 f.press();assert.equal(f.press(1)[0].buttons.some(b=>b.pressed),false,'held stick still blocks');
 f.pad.axes[0]=0;f.press();assert.equal(f.press(1)[0].buttons[1].pressed,true,'cancel leaves original profile');
 calibrate(f);f.cal.begin(f.cal.controllers()[0].key);f.cal.reset();f.press(1);f.cal.save();assert.equal(f.press(1)[0].buttons.some(b=>b.pressed),false);f.press();assert.equal(f.press(1)[0].buttons[1].pressed,true);
});
test('virtual OSD buttons merge after physical mapping and are never swapped twice',()=>{
 const f=fixture();calibrate(f);const device=createDevice(()=>f.cal.getGamepads());device.press(42,'a');f.press(0);
 let buttons=device.getGamepads()[0].buttons;assert.equal(buttons[0].pressed,true);assert.equal(buttons[1].pressed,true);
 device.release(42);f.press(1);buttons=device.getGamepads()[0].buttons;assert.equal(buttons[0].pressed,true);assert.equal(buttons[1].pressed,false);
});
test('calibrated nonstandard button sources are consumed once before the standard touch merger',()=>{
 const f=fixture();f.pad.mapping='';f.cal.begin(f.cal.controllers()[0].key);
 for(const index of [8,9,6,7]){f.press();f.press(index);}f.cal.save();f.press();f.press(8);
 const pad=createDevice(()=>f.cal.getGamepads()).getGamepads()[0];assert.equal(pad.mapping,'standard');assert.equal(pad.buttons[0].pressed,true);assert.equal(pad.buttons[8].pressed,false);
});
test('invalid stored profiles are ignored; storage denial is reported instead of claiming persistence',()=>{
 const f=fixture(),key=f.cal.controllers()[0].key;f.storage.setItem('cubby:controller-labels:v1',JSON.stringify({[key]:[1,1,0,2]}));f.press(1);
 assert.equal(createCalibration(f.read,f.storage).getGamepads()[0].buttons[1].pressed,true);
 const denied=createCalibration(f.read,{getItem(){throw Error('denied');},setItem(){throw Error('denied');}});denied.begin(key);denied.reset();assert.equal(denied.save(),false);
});
test('host installs persistent mapping while OSD hidden, on hub and game paths, before raw consumers',()=>{
 const f=fixture();calibrate(f);
 for(const pathname of ['/','/games/demo/play.html']){
  const doc={readyState:'loading',addEventListener(){},removeEventListener(){},documentElement:{removeAttribute(){}}};
  const win={location:{pathname},document:doc,navigator:{getGamepads:f.read},localStorage:f.storage,addEventListener(){},removeEventListener(){},HandheldPreferences:{preferences:{showTouchControls:()=>false,subscribe:()=>()=>{}}}};
  const osd=require('../runtime/core/host-osd.js').install(win);f.press(1);assert.equal(win.navigator.getGamepads()[0].buttons[0].pressed,true);
  osd.device.press(42,'b');assert.equal(win.navigator.getGamepads()[0].buttons[1].pressed,true);osd.dispose();
 }
});
test('RG353V adapter remains default mapping; calibrated host reads adapter output without double swapping',()=>{
 const f=fixture('Sony Interactive Entertainment DualSense Wireless Controller'),win={navigator:{getGamepads:f.read}};require('../rocknix/gamepad.js').install(win);
 const cal=createCalibration(()=>win.navigator.getGamepads(),f.storage);f.press(1);assert.equal(cal.getGamepads()[0].buttons[0].pressed,true);
 cal.begin(cal.controllers()[0].key);for(const index of [1,0,3,2]){f.press();cal.getGamepads();f.press(index);cal.getGamepads();}cal.save();f.press();cal.getGamepads();f.press(1);
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
