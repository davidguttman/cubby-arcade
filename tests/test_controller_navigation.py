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
  let callbacks=new Map(),nextFrame=0,pad=null,presses=[];
  const noop=()=>{},context=new Proxy({}, {get:()=>noop});
  const mediaEvents={},mediaCalls=[];
  const canvas={getContext:()=>context,addEventListener:noop,removeEventListener:noop};
  const video={addEventListener:(event,fn)=>{mediaEvents[event]=fn},
    load:()=>mediaCalls.push('load'),play:()=>{mediaCalls.push('play');return Promise.resolve()}};
  const sandbox={document:{querySelector:selector=>selector==='video'?video:canvas,getElementById:()=>canvas,
    createElement:()=>({style:{},setAttribute:noop,appendChild:noop,addEventListener:noop,removeEventListener:noop}),
    body:{classList:{add:noop},appendChild:noop},hasFocus:()=>true,hidden:false,visibilityState:'visible',
    addEventListener:noop,removeEventListener:noop},
    navigator:{getGamepads:()=>pad?[pad]:[]},location:{href:'',search:''},innerWidth:640,innerHeight:480,
    performance:{now:()=>0},Image:class{},addEventListener:noop,removeEventListener:noop,
    requestAnimationFrame:fn=>{callbacks.set(++nextFrame,fn);return nextFrame},cancelAnimationFrame:id=>callbacks.delete(id),setInterval:noop,
    localStorage:{getItem:()=>null,setItem:noop},
    fetch:()=>Promise.resolve({ok:true,json:()=>Promise.resolve([
      {entrypoint:'/games/example/index.html',artwork:'cover.svg'}])}),
    LineCutter:{create:()=>({wake:noop,stop:noop,release:noop,press:k=>presses.push(k),
      _debug:()=>false,width:240,height:160,state:'title'})}};
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  for(const source of ['preferences.js','input.js','platform.js','sdk.js','controls.js'])vm.runInContext(fs.readFileSync('runtime/core/'+source,'utf8'),sandbox);
  for(const match of fs.readFileSync(file,'utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
    vm.runInContext(match[1],sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  if(file==='examples/line-cutter/index.html'){
    assert.ok(mediaEvents.ended,'trailer needs replay after completion');
    mediaEvents.ended();
    assert.deepEqual(mediaCalls,['load','play']);
    assert.equal(sandbox.location.href,'');
  }
  const frame=(buttons,axis=0)=>{pad=buttons===null?null:{buttons:Array.from({length:16},(_,i)=>({pressed:buttons.includes(i)})),axes:[axis,0],id:'test'};const pending=[...callbacks.values()];callbacks.clear();pending.forEach(fn=>fn(1000))};
  frame(null);frame(held);frame(held);
  assert.equal(sandbox.location.href,'',file+' accepted held navigation');
  assert.deepEqual(presses,[],file+' accepted held gameplay input');
  frame([]);frame(held);
  if(expected==='press')assert.deepEqual(presses,['a']);
  else assert.equal(sandbox.location.href,expected,file+' rejected fresh input');
}
(async()=>{
  await check('examples/line-cutter/index.html',[0],'play.html');
  await check('examples/line-cutter/index.html',[4,5],'/');
  await check('examples/line-cutter/play.html',[0],'press');
  await check('examples/line-cutter/play.html',[4,5],'/');
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        result = subprocess.run(['node', '-e', harness], cwd=ROOT, text=True,
                                capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
