/* Exercised inside the real renderer by --smoke, not a mocked UI. */
async function checkHub(win,output){
  // Keyboard capture intentionally requires a visible, focused window.
  win.show();win.focus();
  await new Promise(resolve=>setTimeout(resolve,200));
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
      const media=host.querySelector('.preview-media'),favorite=host.querySelector('.favorite');favorite.focus();
      if(host.querySelector('.play-game'))throw Error('Unresolved library must not claim ownership');
      resolveLibrary([game]);await new Promise(resolve=>setTimeout(resolve,0));
      if(!host.querySelector('.play-game')||host.querySelector('.not-installed'))throw Error('Delayed library did not refresh open Store preview');
      if(!host.querySelector('.card-badge svg'))throw Error('Delayed library did not refresh Store ownership badge');
      if(host.querySelector('.preview-media')!==media||document.activeElement!==favorite)throw Error('Ownership refresh interrupted preview or focus');
    }finally{hub?.dispose();host.remove();HandheldPlatform.createPlatform=original;}
  })()`);
  // Exercise pictorial Quit without closing the verification window.
  await win.webContents.executeJavaScript(`(async()=>{
    const originalPlatform=HandheldPlatform.createPlatform,originalInput=HandheldInput.createInput;
    const host=document.createElement('main');document.body.appendChild(host);
    let hub,action,quitCount=0;
    try{
      HandheldInput.createInput=options=>{if(!options.navigationShoulders)throw Error('Hub shoulder opt-in missing');action=options.onAction;return {dispose(){},captureKeyboard(){return ()=>{};}};};
      HandheldPlatform.createPlatform=()=>({capabilities:{quit:true},quit:async()=>{quitCount++;},library:async()=>[],catalog:async()=>[]});
      hub=HandheldHub.mount(host);
      action({action:'previousView'});if(hub.state.view!=='options')throw Error('Left shoulder did not wrap');
      action({action:'nextView'});if(hub.state.view!=='library')throw Error('Right shoulder did not wrap');
      action({action:'nextView'});if(hub.state.view!=='store')throw Error('Right shoulder did not select Store');
      action({action:'nextView'});
      host.querySelector('.quit-app').click();if(!host.querySelector('.quit-confirm').open)throw Error('Quit confirmation missing');
      action({action:'nextView'});if(hub.state.view!=='options')throw Error('Shoulder escaped modal');
      action({action:'back'});if(host.querySelector('.quit-confirm').open||quitCount)throw Error('Cancel quit failed');
      host.querySelector('.quit-app').click();action({action:'right'});action({action:'confirm'});await Promise.resolve();
      if(quitCount!==1)throw Error('Pictorial controller Quit did not call native bridge');
      hub.dispose();host.replaceChildren();
      HandheldPlatform.createPlatform=()=>({capabilities:{quit:false},library:async()=>[],catalog:async()=>[]});
      hub=HandheldHub.mount(host);hub.show('options');if(host.querySelector('.quit-app'))throw Error('Unsupported Quit exposed');
    }finally{hub?.dispose();host.remove();HandheldPlatform.createPlatform=originalPlatform;HandheldInput.createInput=originalInput;}
  })()`);
  const report=await win.webContents.executeJavaScript(`(async()=>{
    const assert=(ok,message)=>{if(!ok)throw Error(message);};
    const prefs=HandheldPreferences.preferences,previous=prefs.get(),previousFavorites=localStorage.getItem('handheld:favorites:v1');
    try{
      const card=document.querySelector('.game-card');assert(card,'Grid card missing');
      assert(document.querySelector('.detail').hidden,'Default must be grid, not detail');
      card.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));
      assert(!document.querySelector('.detail').hidden,'Hover preview missing');
      const video=document.querySelector('.detail video');assert(video,'Actual trailer missing');
      await new Promise(resolve=>setTimeout(resolve,1500));assert(video.currentTime>0&&!video.error,'Detail trailer is not playing');
      document.querySelector('.favorite').click();assert(document.querySelector('.favorite').getAttribute('aria-pressed')==='true','Favorite did not toggle');
      document.querySelector('.detail-close').click();card.click();assert(document.querySelector('.favorite').getAttribute('aria-pressed')==='true','Favorite lost on reopening');
      document.querySelector('[aria-label="store"]').click();assert(document.querySelector('[aria-current]').getAttribute('aria-label')==='store','Store not selected');assert(document.querySelector('.game-card'),'Catalog missing');
      document.querySelector('[aria-label="options"]').click();document.querySelector('[data-mode="on"]').click();assert(prefs.get().touchOverlay==='on','Overlay on failed');document.querySelector('[data-mode="off"]').click();assert(prefs.get().touchOverlay==='off','Overlay off failed');
      document.querySelector('[aria-label="Adult keyboard setup"]').click();assert(document.querySelector('dialog').open,'Adult setup did not open');
      document.querySelector('[data-binding="a"]').click();window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyV',bubbles:true}));
      assert(document.querySelector('[data-binding="a"]').textContent.includes('KeyV'),'Capture failed');
      Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Save').click();assert(prefs.get().keyboard.a[0]==='KeyV','Remap not applied');
      document.querySelector('[aria-label="Adult keyboard setup"]').click();Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Reset keys').click();Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Cancel').click();assert(prefs.get().keyboard.a[0]==='KeyV','Cancel applied draft');
      document.querySelector('[aria-label="library"]').click();
      document.querySelector('.game-card').focus();window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyV',bubbles:true}));assert(document.activeElement.classList.contains('play-game'),'Remapped key did not control library');
      document.querySelector('.detail-close').click();
      return {grid:true,hoverPreview:true,favorite:true,store:true,touchOptions:true,keyboardCapture:true,draftCancel:true,shoulderNavigation:true,quitConfirmation:true};
    }finally{prefs.set(previous);if(previousFavorites===null)localStorage.removeItem('handheld:favorites:v1');else localStorage.setItem('handheld:favorites:v1',previousFavorites);}
  })()`);
  if(output){const fs=require('node:fs/promises'),path=require('node:path');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'library.png'),(await win.webContents.capturePage()).toPNG());
    const capture=async(name,script)=>{await win.webContents.executeJavaScript(script);await new Promise(resolve=>setTimeout(resolve,500));await fs.writeFile(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
    await capture('detail',"document.querySelector('.game-card').click()");
    await capture('options',"document.querySelector('[aria-label=options]').click()");
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
  return report;
}
module.exports={checkHub};
