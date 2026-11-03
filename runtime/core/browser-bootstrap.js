/* Native hosts supply their bridge before this script runs. Ordinary browsers
 * acquire persistent storage and a controlling root worker before exposing install. */
(async function(win){
 'use strict';
 const host=win.document.getElementById('hub');
 if(win.HandheldPlatformOptions?.bridge||win.HandheldPlatformOptions?.kind==='kiosk'){win.HandheldHub.mount(host);return;}
 let timeout;
 try{
  if(!win.isSecureContext||!win.navigator?.serviceWorker)throw Error('Browser storage unavailable');
  const workers=win.navigator.serviceWorker;
  await Promise.race([(async()=>{
   await workers.register('/cubby-worker.js',{scope:'/',updateViaCache:'none'});
   await workers.ready;
   if(!workers.controller)await new Promise(resolve=>{const changed=()=>{if(workers.controller){workers.removeEventListener('controllerchange',changed);resolve();}};workers.addEventListener('controllerchange',changed);changed();});
  })(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Worker unavailable')),20000);})]);
  const bridge=win.HandheldBrowserStore.createBridge();await bridge.ready();
  win.HandheldPlatformOptions={kind:'web',bridge};
  let hub,stopUpdates;
  function mount(){hub?.dispose();stopUpdates?.();hub=win.HandheldHub.mount(host);stopUpdates=win.HandheldBrowserStore.startUpdateChecks(win,bridge);}
  mount();
  // pagehide disposes the hub and cancels update work. A BFCache restoration
  // needs fresh UI subscriptions and timers, not a second worker registration.
  win.addEventListener('pageshow',event=>{if(event.persisted)mount();});
 }catch(error){
  const alert=win.document.createElement('div');alert.className='browser-storage-error';alert.setAttribute('role','alert');alert.setAttribute('aria-label','Browser game storage unavailable. Allow site storage and reload to retry.');alert.textContent='⚠';host.replaceChildren();host.appendChild(alert);
 }finally{clearTimeout(timeout);}
})(window);
