/* RG353V's InputPlumber presents its Nintendo-labelled buttons as a DualSense.
 * This host-only adapter runs before menu input and the game's virtual OSD.
 * Do not load it on other hosts or swap immutable game-package controls. */
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else api.install(root);
})(globalThis,function(){
 'use strict';
 const builtin='Sony Interactive Entertainment DualSense Wireless Controller';
 const installed=Symbol.for('cubby.rg353v.face-mapping');
 function install(win){
  const nav=win.navigator;
  if(!nav?.getGamepads||nav[installed])return;
  const read=nav.getGamepads.bind(nav);
  Object.defineProperty(nav,'getGamepads',{configurable:true,value(){
   return Array.from(read()||[],pad=>{
    if(!pad||pad.id!==builtin||pad.mapping!=='standard'||pad.buttons.length<4)return pad;
    const buttons=Array.from(pad.buttons);
    [buttons[0],buttons[1]]=[buttons[1],buttons[0]];
    [buttons[2],buttons[3]]=[buttons[3],buttons[2]];
    // Native Gamepad attributes are prototype getters, not enumerable fields.
    return {...pad,id:pad.id,index:pad.index,mapping:pad.mapping,connected:pad.connected,
     timestamp:pad.timestamp,buttons,axes:pad.axes,vibrationActuator:pad.vibrationActuator,
     hapticActuators:pad.hapticActuators,pose:pad.pose};
   });
  }});
  Object.defineProperty(nav,installed,{value:true});
 }
 return {install};
});
