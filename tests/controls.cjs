const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(mode){
 const attached=[];
 const element=()=>({children:[],style:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},appendChild(child){this.children.push(child);},remove(){}});
 const document={createElement:element,body:element()};
 const sandbox={document};vm.createContext(sandbox);
 vm.runInContext(fs.readFileSync('runtime/core/controls.js','utf8'),sandbox);
 sandbox.HandheldControls.createControls({attachPointer:(node,button)=>attached.push([node,button()]),preferences:{showTouchControls:()=>true,subscribe:()=>()=>{}}},mode);
 return {bar:document.body.children[0],attached};
}
test('game controls expose spatial hooks without changing any logical pointer mapping',()=>{
 const {bar,attached}=fixture('game');
 assert.match(bar.className,/\bgame-controls\b/);
 assert.deepEqual(attached.map(([,button])=>button),['exit','left','up','down','right','a','b','start']);
 for(const [node,button] of attached){
  assert.match(node.className,new RegExp('\\bcontrol-'+button+'\\b'));
  assert.equal(node.attributes['aria-label'],button);
  assert.match(node.innerHTML,/<svg/);
 }
});
test('title and navigation preserve their compact control sets',()=>{
 for(const [mode,expected] of [['title',['exit','start']],['library',['left','start','right']]]){
  const {bar,attached}=fixture(mode);
  assert.doesNotMatch(bar.className,/\bgame-controls\b/);
  assert.deepEqual(attached.map(([,button])=>button),expected);
 }
});
