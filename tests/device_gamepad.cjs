const test = require('node:test'), assert = require('node:assert/strict');
const {install} = require('../rocknix/gamepad.js');
const builtin = 'Sony Interactive Entertainment DualSense Wireless Controller';
function pad(id=builtin) {
 return {id,index:0,mapping:'standard',connected:true,timestamp:12,
  buttons:Array.from({length:17},(_,i)=>({pressed:i===0||i===2,touched:i===0,value:i/20})),
  axes:[.25,-.5],vibrationActuator:{pulse(){}}};
}
test('RG353V face labels swap once without losing native button or pad metadata',()=>{
 const raw=pad(),read=()=>[raw],win={navigator:{getGamepads:read}};
 install(win);const normalized=win.navigator.getGamepads()[0];
 for(const [a,b] of [[0,1],[1,0],[2,3],[3,2]])assert.equal(normalized.buttons[a],raw.buttons[b]);
 assert.equal(normalized.buttons[9],raw.buttons[9]);assert.equal(normalized.axes,raw.axes);
 assert.equal(normalized.vibrationActuator,raw.vibrationActuator);assert.equal(normalized.timestamp,12);
 assert.equal(raw.buttons[0].pressed,true);install(win);
 assert.equal(win.navigator.getGamepads()[0].buttons[1],raw.buttons[0]);
});
test('external controllers and sparse slots remain unchanged',()=>{
 const other=pad('Xbox Controller'),native=pad();
 const win={navigator:{getGamepads:()=>[null,other,native]}};install(win);
 const pads=win.navigator.getGamepads();assert.equal(pads[0],null);assert.equal(pads[1],other);
 assert.equal(pads[2].buttons[1],native.buttons[0]);
});
test('normalization precedes game OSD so virtual buttons are not swapped',()=>{
 const {createDevice}=require('../runtime/core/host-osd.js'),raw=pad();
 const win={navigator:{getGamepads:()=>[raw]}};install(win);
 const device=createDevice(()=>win.navigator.getGamepads());device.press(1,'a');
 const buttons=device.getGamepads()[0].buttons;
 assert.equal(buttons[0].pressed,true);assert.equal(buttons[1].pressed,true);
 assert.equal(buttons[3].pressed,true);assert.equal(buttons[2].pressed,false);
});
test('native prototype attributes survive and repeated script evaluation does not swap twice',()=>{
 const vm=require('node:vm'),fs=require('node:fs'),raw=pad();
 const prototype={};
 for(const [key,value] of Object.entries(raw))Object.defineProperty(prototype,key,{get(){return value;}});
 const native=Object.create(prototype);
 const context={navigator:{getGamepads:()=>[native]}};vm.createContext(context);
 const source=fs.readFileSync(require.resolve('../rocknix/gamepad.js'),'utf8');
 vm.runInContext(source,context);vm.runInContext(source,context);
 const mapped=context.navigator.getGamepads()[0];
 assert.equal(mapped.buttons[1],raw.buttons[0]);assert.equal(mapped.id,raw.id);
 assert.equal(mapped.index,0);assert.equal(mapped.axes,raw.axes);
});
