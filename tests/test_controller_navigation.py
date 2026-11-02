"""Run real page scripts against a controller arriving with held buttons."""
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('node'), 'Node JS interpreter required (no server)')
class ControllerNavigationTests(unittest.TestCase):
    def test_new_pages_wait_for_controller_release(self):
        harness = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
async function check(file,held,expected){
  let callback,pad=null,presses=[];
  const noop=()=>{},context=new Proxy({}, {get:()=>noop});
  const canvas={getContext:()=>context,addEventListener:noop};
  const sandbox={document:{querySelector:()=>canvas,getElementById:()=>canvas,
    body:{classList:{add:noop}},hasFocus:()=>true,visibilityState:'visible'},
    navigator:{getGamepads:()=>pad?[pad]:[]},location:{href:'',search:''},innerWidth:640,innerHeight:480,
    performance:{now:()=>0},Image:class{},addEventListener:noop,
    requestAnimationFrame:fn=>{callback=fn},setInterval:noop,
    localStorage:{getItem:()=>null,setItem:noop},
    fetch:()=>Promise.resolve({ok:true,json:()=>Promise.resolve([
      {entrypoint:'/games/example/index.html',artwork:'cover.svg'}])}),
    LineCutter:{create:()=>({wake:noop,stop:noop,press:k=>presses.push(k),
      _debug:()=>false,width:240,height:160,state:'title'})}};
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  for(const match of fs.readFileSync(file,'utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
    vm.runInContext(match[1],sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  const frame=(buttons,axis=0)=>{pad=buttons===null?null:{buttons:Array.from({length:16},(_,i)=>({pressed:buttons.includes(i)})),axes:[axis,0],id:'test'};callback(1000)};
  frame(null);frame(held);frame(held);
  assert.equal(sandbox.location.href,'',file+' accepted held navigation');
  assert.deepEqual(presses,[],file+' accepted held gameplay input');
  frame([]);frame(held);
  if(expected==='press')assert.deepEqual(presses,['a']);
  else assert.equal(sandbox.location.href,expected,file+' rejected fresh input');
}
(async()=>{
  await check('runtime/index.html',[0],'/games/example/index.html');
  await check('examples/line-cutter/index.html',[0],'play.html');
  await check('examples/line-cutter/index.html',[4,5],'/');
  await check('examples/line-cutter/play.html',[0],'press');
  await check('examples/line-cutter/play.html',[4,5],'./index.html');
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        result = subprocess.run(['node', '-e', harness], cwd=ROOT, text=True,
                                capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
