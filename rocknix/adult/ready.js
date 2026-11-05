/* Only initialized application pages may acknowledge a supervisor trial. */
(() => {
  'use strict';
  const token=document.currentScript.dataset.token;
  let requested=false, failed=false;
  window.addEventListener('error',()=>{failed=true;});
  window.addEventListener('unhandledrejection',()=>{failed=true;});
  // Called explicitly after the hub mounts or an adult page finishes wiring
  // and rendering its initial state. A loaded document alone proves nothing.
  window.CubbyUIReady=()=>{
    if(requested)return;
    requested=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(failed)return;
      fetch('/api/ui-ready',{
        method:'POST',headers:{'Content-Type':'application/json','X-Cubby-Session':token},body:'{}'
      }).catch(()=>{});
    }));
  };
})();
