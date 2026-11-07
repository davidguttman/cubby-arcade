// Smokes answer the settings question the way an adult does.
const passGate=String.raw`root=>{const q=root.querySelector('.gate-question').textContent.match(/(\d) ([+×]) (\d)/),answer=String(q[2]==='+'?+q[1] + +q[3]:q[1]*q[3]);for(const digit of answer)Array.from(root.querySelectorAll('.gate-pad button')).find(b=>b.textContent===digit).click();root.querySelector('.gate-submit').click();}`;
/* Startup selection is exercised against real DOM with deferred discovery. */
async function checkStartup(win){
  return win.webContents.executeJavaScript(`(async()=>{
    const original=HandheldPlatform.createPlatform,game={id:'startup-test',artwork:'/missing-test-art',entrypoint:'/test-play',manifest_url:'/manifest'};
    const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
    const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
    async function fixture(check){
      const host=document.createElement('main'),firstLibrary=deferred(),firstCatalog=deferred();
      let hub,entries=[],calls=0,notify;
      HandheldPlatform.createPlatform=()=>({capabilities:{install:true,uninstall:true},
        library:()=>++calls===1?firstLibrary.promise:Promise.resolve(entries),catalog:()=>firstCatalog.promise,
        install:async()=>{entries=[game];notify({[game.id]:{phase:'installed',version:'1'}});},uninstall:async()=>{entries=[];},
        onInstallState:callback=>(notify=callback,()=>{})});
      document.body.appendChild(host);
      const assert=(ok,message)=>{if(!ok)throw Error(message);};
      const selected=view=>assert(hub.state.view===view&&host.querySelector('[aria-current="page"]')?.getAttribute('aria-label')===view,'Expected active '+view+', got '+hub.state.view);
      try{hub=HandheldHub.mount(host);await check({host,hub,selected,assert,library:firstLibrary,catalog:firstCatalog,setEntries:value=>{entries=value;},notify:states=>notify(states)});}
      finally{hub?.dispose();host.remove();HandheldPlatform.createPlatform=original;}
    }
    await fixture(async({host,selected,assert,library,catalog})=>{
      catalog.resolve([game]);await tick();library.resolve([]);await tick();selected('store');
      assert(host.querySelector('.game-card'),'Empty startup did not show ready catalog');
      assert(!host.querySelector('.detail').hidden&&host.querySelector('.download-game'),'Store startup must open the first game preview and download action');
      host.querySelector('[aria-label="library"]').click();selected('library');
      assert(host.querySelector('.shelf-status.empty'),'Manually chosen empty Library missing');
    });
    await fixture(async({host,selected,assert,library,catalog})=>{
      library.resolve([]);await tick();selected('store');assert(host.querySelector('.shelf-status.loading'),'Store must retain catalog loading state');
      catalog.resolve([game]);await tick();assert(host.querySelector('.game-card'),'Late catalog did not populate Store');
      assert(!host.querySelector('.detail').hidden,'Late catalog must open its first game');
      host.querySelector('.game-card').click();host.querySelector('.download-game').click();await tick();selected('library');
      assert(document.activeElement===host.querySelector('.play-game'),'Finished download must hand off to Library Play');
      host.querySelector('[aria-label="store"]').click();selected('store');
      assert(host.querySelector('.game-card').disabled&&host.querySelector('.detail').hidden&&!host.querySelector('.play-game'),'Owned Store game must not be interactable');
      host.querySelector('[aria-label="library"]').click();host.querySelector('.game-card').click();
      host.querySelector('.uninstall-game').click();host.querySelector('.confirm-uninstall').click();await tick();selected('library');
      assert(host.querySelector('.shelf-status.empty'),'Last uninstall did not leave empty Library in place');
    });
    await fixture(async({host,selected,assert,library,catalog})=>{
      library.resolve([]);catalog.resolve([]);await tick();selected('store');assert(host.querySelector('.shelf-status.empty'),'Empty catalog should stay on Store');
    });
    await fixture(async({selected,library,catalog})=>{catalog.resolve([game]);library.resolve([game]);await tick();selected('library');});
    await fixture(async({host,hub,selected,assert,library,catalog})=>{
      const first={...game,id:'catalog-first'},second={...game,id:'catalog-second'};
      library.resolve([game]);catalog.resolve([first,second]);await tick();selected('library');
      assert(hub.state.detail?.id===game.id&&!host.querySelector('.detail').hidden&&host.querySelector('.play-game'),'Library must select its first game and show Play');
      assert(host.querySelector('.game-card.is-selected')?.dataset.gameId===game.id,'First Library card must be visibly selected');
      host.querySelector('[aria-label="store"]').click();selected('store');
      assert(hub.state.detail?.id===first.id&&!host.querySelector('.detail').hidden,'Store must select the first catalog game');
      assert(host.querySelector('.game-card.is-selected')?.dataset.gameId===first.id,'First Store card must be visibly selected');
      host.querySelector('[data-game-id="'+second.id+'"]').click();
      const media=host.querySelector('.preview-media'),favorite=host.querySelector('.favorite');favorite.focus();
      await tick();assert(hub.state.detail?.id===second.id&&host.querySelector('.preview-media')===media&&document.activeElement===favorite,'Explicit second-game preview/focus was replaced');
      host.querySelector('[aria-label="options"]').click();host.querySelector('[aria-label="store"]').click();
      assert(hub.state.detail?.id===first.id,'Entering Store must default to its first game, not the prior featured cover');
    });
    await fixture(async({host,selected,assert,library,catalog})=>{
      catalog.resolve([game]);library.reject(Error('Discovery failed'));await tick();selected('library');assert(host.querySelector('.shelf-status.error'),'Failed discovery was treated as empty');
    });
    for(const view of ['library','options'])await fixture(async({host,selected,library,catalog})=>{
      host.querySelector('[aria-label="'+view+'"]').click();catalog.resolve([game]);library.resolve([]);await tick();selected(view);
    });
    await fixture(async({host,selected,assert,library,catalog})=>{
      catalog.resolve([game]);await tick();host.querySelector('[aria-label="store"]').click();host.querySelector('.game-card').click();
      const media=host.querySelector('.preview-media'),favorite=host.querySelector('.favorite');favorite.focus();
      library.resolve([]);await tick();selected('store');
      assert(host.querySelector('.preview-media')===media&&document.activeElement===favorite,'Empty discovery interrupted explicit Store preview/focus');
    });
    await fixture(async({host,selected,library,catalog,notify,setEntries})=>{
      host.querySelector('[aria-label="store"]').click();host.querySelector('[aria-label="library"]').click();
      catalog.resolve([game]);library.resolve([]);await tick();selected('library');
      setEntries([game]);notify({[game.id]:{phase:'installed',version:'1'}});await tick();selected('library');
      setEntries([]);notify({[game.id]:{phase:'installed',version:'2'}});await tick();selected('library');
    });
    return {emptyStartup:true,nonemptyStartup:true,failedDiscovery:true,pendingNavigation:true,previewPreserved:true,laterRefresh:true,storeFirstGame:true};
  })()`);
}
/* Exercised inside the real renderer by --smoke, not a mocked UI. */
/* Controller setup in the real renderer, driven by a scripted pad: no mouse,
   touch or keyboard after choosing the tile. Screenshots each visible state. */
async function checkControllerSetup(win,output){
  const fs=require('node:fs/promises'),path=require('node:path');
  const run=script=>win.webContents.executeJavaScript(script);
  const shot=async(name,script,delay=300)=>{await run(script);await new Promise(resolve=>setTimeout(resolve,delay));if(output)await fs.writeFile(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  if(output)await fs.mkdir(output,{recursive:true});
  await run(`(()=>{
    const buttons=Array.from({length:17},()=>({pressed:false,touched:false,value:0})),pad={id:'Smoke pad',index:0,mapping:'standard',connected:true,buttons,axes:[0,0,0,0]};
    const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
    const calibration=HandheldHostOSD.createCalibration(()=>[pad],storage),original=window.HandheldOSD,host=document.createElement('main');
    const press=(...indices)=>{buttons.forEach((b,i)=>{b.pressed=indices.includes(i);b.value=b.pressed?1:0;});calibration.getGamepads();};
    window.HandheldOSD={calibration,reset(){}};document.body.appendChild(host);
    const hub=HandheldHub.mount(host);hub.show('options');(${passGate})(host);
    window.__controllerSmoke={host,hub,press,values,original,dialog:host.querySelector('.controller-setup')};
    press(0);host.querySelector('.controller-settings').click();press();
  })()`);
  const assert=async(check,message)=>{if(!await run(`(()=>{const {host,dialog,values}=window.__controllerSmoke;return ${check};})()`))throw Error(message);};
  try{
    await assert(`dialog.open&&dialog.querySelector('.calibration-prompt').textContent==='A'&&!dialog.querySelector('select')`,'Controller setup did not open straight to A');
    await shot('controller-setup-a','void 0');
    await shot('controller-setup-progress','(()=>{const {press}=window.__controllerSmoke;press(1);press();press(0);press();})()');
    await assert(`dialog.querySelector('.calibration-prompt').textContent==='X'`,'Controller setup did not advance to X');
    await shot('controller-setup-rejected','window.__controllerSmoke.press(0)',120);
    await shot('controller-setup-saved','(()=>{const {press}=window.__controllerSmoke;press();press(3);press();press(2);})()',250);
    await assert(`dialog.open&&dialog.querySelector('.calibration-prompt').classList.contains('done')`,'Controller setup did not confirm');
    await new Promise(resolve=>setTimeout(resolve,1200));
    await assert(`!dialog.open&&document.activeElement===host.querySelector('.controller-settings')&&JSON.parse(values.get('cubby:controller-labels:v1'))['["Smoke pad","standard",17,4]'].join()==='1,0,3,2'`,'Controller setup did not save, close and restore focus');
    await run(`(()=>{const {host,press}=window.__controllerSmoke;press();host.querySelector('.controller-settings').click();press();press(9);})()`);
    await assert(`!dialog.open`,'Start did not leave controller setup');
  }finally{
    await run(`(()=>{const {hub,host,original,press}=window.__controllerSmoke;press();hub.dispose();host.remove();window.HandheldOSD=original;delete window.__controllerSmoke;})()`);
  }
  return {controllerSetup:true};
}
async function checkHub(win,output){
  // Keyboard capture intentionally requires a visible, focused window.
  win.show();win.focus();
  await new Promise(resolve=>setTimeout(resolve,200));
  const startup=await checkStartup(win);
  // A fast catalog must not permanently classify a slow-loading library as unowned.
  await win.webContents.executeJavaScript(`(async()=>{
    const original=HandheldPlatform.createPlatform,host=document.createElement('main');
    const game={id:'delayed-library-test',artwork:'/missing-test-art',entrypoint:'/test-play'};
    let resolveLibrary,hub;
    HandheldPlatform.createPlatform=()=>({library:()=>new Promise(resolve=>resolveLibrary=resolve),catalog:()=>Promise.resolve([game])});
    document.body.appendChild(host);
    try{
      hub=HandheldHub.mount(host);hub.show('store');await new Promise(resolve=>setTimeout(resolve,0));
      host.querySelector('.game-card').click();
      if(host.querySelector('.play-game'))throw Error('Unresolved library must not claim ownership');
      resolveLibrary([game]);await new Promise(resolve=>setTimeout(resolve,0));
      if(host.querySelector('.play-game')||!host.querySelector('.detail').hidden)throw Error('Delayed library left an owned game open in Store');
      if(!host.querySelector('.card-badge svg')||!host.querySelector('.game-card').disabled)throw Error('Delayed library did not refresh Store ownership');
    }finally{hub?.dispose();host.remove();HandheldPlatform.createPlatform=original;}
  })()`);
  // A live update may change the entrypoint while its preview stays open.
  await win.webContents.executeJavaScript(`(async()=>{
    const host=document.createElement('main');document.body.appendChild(host);
    let entries=[{id:'live-update',version:'1',artwork:'/missing-test-art',entrypoint:'/games/live-update/old.html'}],notify,hub;
    const location={href:''},platform={capabilities:{install:true},library:async()=>entries,catalog:async()=>entries,onInstallState:callback=>(notify=callback,()=>{})};
    const listeners=new Map();
    const fakeWindow={HandheldPlatform:{createPlatform:()=>platform},HandheldPreferences,HandheldInput:{createInput:()=>({dispose(){}})},localStorage:window.localStorage,location,
      addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(listener);},
      removeEventListener(type,listener){listeners.get(type)?.delete(listener);},fetch:async()=>({ok:true})};
    const owner=new Proxy(document,{get(target,key){if(key==='defaultView')return fakeWindow;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const scopedHost=new Proxy(host,{set(target,key,value){return Reflect.set(target,key,value,target);},get(target,key){if(key==='ownerDocument')return owner;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    try{
      hub=HandheldHub.mount(scopedHost);await new Promise(r=>setTimeout(r,0));host.querySelector('.game-card').click();
      const media=host.querySelector('.preview-media'),play=host.querySelector('.play-game');play.focus();
      entries=[{...entries[0],version:'2',entrypoint:'/games/live-update/new.html'}];notify({'live-update':{phase:'installed',version:'2'}});await new Promise(r=>setTimeout(r,0));
      if(host.querySelector('.preview-media')!==media||host.querySelector('.play-game')!==play||document.activeElement!==play)throw Error('Live update disrupted preview/focus');
      play.click();if(location.href!=='/games/live-update/new.html')throw Error('Live update Play used stale entrypoint: '+location.href);
    }finally{hub?.dispose();host.remove();if([...listeners.values()].some(set=>set.size))throw Error('Disposed live-update fixture retained window listeners');}
  })()`);
  // Exercise pictorial Quit without closing the verification window.
  await win.webContents.executeJavaScript(`(async()=>{
    const originalPlatform=HandheldPlatform.createPlatform,originalInput=HandheldInput.createInput;
    const host=document.createElement('main');document.body.appendChild(host);
    let hub,action,quitCount=0;const passGate=${passGate};
    try{
      HandheldInput.createInput=options=>{if(!options.navigationShoulders)throw Error('Hub shoulder opt-in missing');action=options.onAction;return {dispose(){},captureKeyboard(){return ()=>{};}};};
      HandheldPlatform.createPlatform=()=>({capabilities:{quit:true},quit:async()=>{quitCount++;},library:async()=>[],catalog:async()=>[]});
      hub=HandheldHub.mount(host);
      action({action:'previousView'});if(hub.state.view!=='options')throw Error('Left shoulder did not wrap');
      action({action:'nextView'});if(hub.state.view!=='library')throw Error('Right shoulder did not wrap');
      action({action:'nextView'});if(hub.state.view!=='store')throw Error('Right shoulder did not select Store');
      action({action:'nextView'});if(host.querySelector('.quit-app'))throw Error('Quit shown before the adult question');passGate(host);
      host.querySelector('.quit-app').click();if(!host.querySelector('.quit-confirm').open)throw Error('Quit confirmation missing');
      action({action:'nextView'});if(hub.state.view!=='options')throw Error('Shoulder escaped modal');
      action({action:'back'});if(host.querySelector('.quit-confirm').open||quitCount)throw Error('Cancel quit failed');
      host.querySelector('.quit-app').click();action({action:'right'});action({action:'confirm'});await Promise.resolve();
      if(quitCount!==1)throw Error('Pictorial controller Quit did not call native bridge');
      hub.dispose();host.replaceChildren();
      HandheldPlatform.createPlatform=()=>({capabilities:{quit:false},library:async()=>[],catalog:async()=>[]});
      hub=HandheldHub.mount(host);hub.show('options');passGate(host);if(host.querySelector('.quit-app'))throw Error('Unsupported Quit exposed');
    }finally{hub?.dispose();host.remove();HandheldPlatform.createPlatform=originalPlatform;HandheldInput.createInput=originalInput;}
  })()`);
  const report=await win.webContents.executeJavaScript(`(async()=>{
    const assert=(ok,message)=>{if(!ok)throw Error(message);};
    const prefs=HandheldPreferences.preferences,previous=prefs.get(),previousFavorites=localStorage.getItem('handheld:favorites:v1');const passGate=${passGate};
    try{
      const card=document.querySelector('.game-card');assert(card,'Grid card missing');
      assert(!document.querySelector('.detail').hidden&&document.querySelector('.play-game'),'Default Library selection must show preview and Play');
      assert(card.classList.contains('is-selected'),'Default Library card must be visibly selected');
      card.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));
      assert(!document.querySelector('.detail').hidden,'Hover preview missing');
      const video=document.querySelector('.detail video');assert(video,'Actual trailer missing');
      await new Promise(resolve=>setTimeout(resolve,1500));assert(video.currentTime>0&&!video.error,'Detail trailer is not playing');
      document.querySelector('.favorite').click();assert(document.querySelector('.favorite').getAttribute('aria-pressed')==='true','Favorite did not toggle');
      document.querySelector('.detail-close').click();assert(!document.querySelector('.detail').hidden&&document.querySelector('.play-game'),'Back hid Library actions');assert(document.querySelector('.detail video')===video&&document.activeElement===card,'Back replaced trailer or lost shelf focus');card.click();assert(document.querySelector('.favorite').getAttribute('aria-pressed')==='true','Favorite lost on returning to shelf');
      document.querySelector('[aria-label="store"]').click();assert(document.querySelector('[aria-current]').getAttribute('aria-label')==='store','Store not selected');assert(document.querySelector('.game-card'),'Catalog missing');
      document.querySelector('[aria-label="options"]').click();assert(document.querySelector('.settings-gate')&&!document.querySelector('.adult-entry'),'Settings shown before the adult question');passGate(document);assert(!document.querySelector('.touch-settings,[data-mode]'),'Manual touch options must not exist');
      prefs.set({touchOverlay:'on'});assert(!prefs.showTouchControls({navigator:{maxTouchPoints:0}}),'Legacy on override forced desktop controls');
      prefs.set({touchOverlay:'off'});assert(prefs.showTouchControls({navigator:{maxTouchPoints:1}}),'Legacy off override hid touch controls');assert(prefs.get().touchOverlay==='auto','Touch mode must remain automatic');
      document.querySelector('[aria-label="Adult keyboard setup"]').click();assert(document.querySelector('dialog').open,'Adult setup did not open');
      document.querySelector('[data-binding="a"]').click();window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyV',bubbles:true}));
      assert(document.querySelector('[data-binding="a"]').textContent.includes('KeyV'),'Capture failed');
      Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Save').click();assert(prefs.get().keyboard.a[0]==='KeyV','Remap not applied');
      document.querySelector('[aria-label="Adult keyboard setup"]').click();Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Reset keys').click();Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Cancel').click();assert(prefs.get().keyboard.a[0]==='KeyV','Cancel applied draft');
      document.querySelector('[aria-label="library"]').click();
      document.querySelector('.game-card').focus();window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyV',bubbles:true}));assert(document.activeElement.classList.contains('play-game'),'Remapped key did not control library');
      document.querySelector('.detail-close').click();assert(!document.querySelector('.detail').hidden&&document.querySelector('.play-game'),'Back must keep Library actionable');
      return {grid:true,hoverPreview:true,favorite:true,store:true,automaticTouch:true,keyboardCapture:true,draftCancel:true,shoulderNavigation:true,quitConfirmation:true};
    }finally{prefs.set(previous);if(previousFavorites===null)localStorage.removeItem('handheld:favorites:v1');else localStorage.setItem('handheld:favorites:v1',previousFavorites);}
  })()`);
  if(output){const fs=require('node:fs/promises'),path=require('node:path');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'library.png'),(await win.webContents.capturePage()).toPNG());
    const capture=async(name,script)=>{await win.webContents.executeJavaScript(script);await new Promise(resolve=>setTimeout(resolve,500));await fs.writeFile(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
    await capture('detail',"document.querySelector('.game-card').click()");
    await capture('settings-gate',"document.querySelector('[aria-label=options]').click()");
    await capture('options',`(${passGate})(document)`);
    await capture('quit-confirm',"document.querySelector('.quit-app').click()");
    await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"Cancel quit\"]').click()");
    await capture('adult',"document.querySelector('[aria-label=\"Adult keyboard setup\"]').click()");
    await win.webContents.executeJavaScript("document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));document.querySelector('[aria-label=library]').click()");
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await capture('mobile-library','void 0');
    await capture('mobile-detail', "document.querySelector('.game-card').click()");
    const overflow=await win.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth');if(overflow)throw Error('Mobile hub overflow');
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:640,height:480,deviceScaleFactor:1,mobile:false});await capture('handheld-library', "document.querySelector('[aria-label=library]').click()");
    await capture('handheld-detail', "document.querySelector('.game-card').click()");await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');win.webContents.debugger.detach();
  }
  const controller=await checkControllerSetup(win,output);
  return {...report,...controller,startup};
}
module.exports={passGate,checkHub,checkStartup,checkControllerSetup};
