// Cubby's one on-screen keyboard: the Wi-Fi password and player names both use it.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {create,LAYOUTS}=require('../runtime/core/keyboard.js');
function dom(){
 const doc={activeElement:null};
 class El{constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.dataset={};this.attributes={};const cls=new Set();this.classList={add:c=>cls.add(c),contains:c=>cls.has(c)};this.ownerDocument=doc;}
  appendChild(e){this.children.push(e);return e;}replaceChildren(){this.children=[];}addEventListener(t,f){(this.listeners[t]??=[]).push(f);}
  click(){(this.listeners.click||[]).forEach(f=>f());}focus(){doc.activeElement=this;}setAttribute(k,v){this.attributes[k]=v;}querySelector(){return this.children[0]||null;}}
 doc.createElement=tag=>new El(tag);
 return {container:new El('div'),labels(c){return c.children.map(b=>b.attributes['aria-label']||b.textContent);},press(c,label){c.children.find(b=>(b.attributes['aria-label']||b.textContent)===label).click();}};
}
test('the password layout is exactly the Wi-Fi keyboard it replaced',()=>{
 const d=dom(),field={value:'',maxLength:64},board=create({container:d.container,field,layout:'password'});
 assert.deepEqual(d.labels(d.container),[...'1234567890','Backspace',...'qwertyuiop','-',...'asdfghjkl',';',"'",...'zxcvbnm',',','.','/','?','_','=','+','[',']','{','}',':','"','\\','|','ABC','Space','`','~','<','>']);
 d.press(d.container,'q');d.press(d.container,'Space');d.press(d.container,'Backspace');assert.equal(field.value,'q');
 board.toggleCase();assert.deepEqual(d.labels(d.container).slice(0,12),[...'!@#$%^&*()','Backspace','Q']);
 field.value='x'.repeat(64);d.press(d.container,'Q');assert.equal(field.value.length,64,'maxLength holds');
});
test('the name layout has letters and name marks, starts each name with a capital, and caps the length',()=>{
 const d=dom(),field={value:'',maxLength:12},board=create({container:d.container,field,layout:'name',capitalizeFirst:true});
 assert.equal(d.container.dataset.layout,'name');
 assert.deepEqual(d.labels(d.container),[...'QWERTYUIOP',...'ASDFGHJKL','Backspace','abc',...'ZXCVBNM','-',"'",'.','Space']);
 d.press(d.container,'M');assert.equal(field.value,'M');assert.equal(board.shifted,false,'After the first letter, lower case');
 for(const c of 'aya')d.press(d.container,c);assert.equal(field.value,'Maya');
 for(let i=0;i<4;i++)d.press(d.container,'Backspace');assert.equal(board.shifted,true,'An empty name starts with a capital again');
 d.press(d.container,'A');for(let i=0;i<20;i++)d.press(d.container,'a');assert.equal(field.value.length,12);
 assert.throws(()=>create({container:dom().container,field,layout:'nope'}));
 assert.ok(LAYOUTS.password&&LAYOUTS.name);
});
test('the Wi-Fi page types with the shared keyboard and has none of its own',()=>{
 const html=fs.readFileSync('rocknix/adult/network.html','utf8'),js=fs.readFileSync('rocknix/adult/network.js','utf8');
 assert.ok(html.indexOf('/runtime/core/keyboard.js')>=0&&html.indexOf('/runtime/core/keyboard.js')<html.indexOf('/adult/network.js'));
 assert.match(html,/\/runtime\/core\/keyboard\.css/);assert.match(js,/HandheldKeyboard\.create\(/);
 assert.doesNotMatch(js,/qwertyuiop|function keyboard\(/);
 assert.match(fs.readFileSync('runtime/index.html','utf8'),/keyboard\.js/);
});
