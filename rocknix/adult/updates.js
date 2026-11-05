(() => {
  'use strict';
  const token=document.querySelector('meta[name="cubby-session"]').content;
  const $=id=>document.getElementById(id);
  let pending=false, last=[];
  async function request(action) {
    const r=await fetch('/api/update',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Cubby-Session':token},body:JSON.stringify({action})});
    const value=await r.json(); if(!r.ok) throw Error(value.error||'Update unavailable'); return value;
  }
  async function status() {
    try {
      const r=await request('status');
      const labels={unconfigured:'Updates are not configured on this installation.',idle:'Cubby is ready. Check for updates when online.',checking:'Checking for updates…',available:'An update is available.',downloading:'Downloading and verifying update…',staged:'Update verified. Install when ready.',trial:'Restarting Cubby…',rolled_back:'The last update could not start. The previous Cubby was restored.',error:r.error||'Update failed. Please retry.'};
      $('status').textContent=labels[r.phase]||r.phase;
      $('download').disabled=r.phase!=='available'; $('apply').disabled=r.phase!=='staged';
      $('check').disabled=pending||!r.configured||['checking','downloading','trial'].includes(r.phase);
      if(document.activeElement?.disabled) (r.phase==='staged'?$('apply'):r.phase==='available'?$('download'):!r.configured?$('back'):$('check')).focus();
      return true;
    } catch(e) { $('status').textContent=e.message; return false; }
  }
  for(const action of ['check','download','apply']) $(action).onclick=async()=>{
    if(pending)return; pending=true;
    try { await request(action); }
    catch(e){$('status').textContent=e.message;}
    finally {pending=false; await status();}
  };
  $('back').onclick=()=>location.replace('/adult/network');
  function buttons(){return [...document.querySelectorAll('button')].filter(b=>!b.disabled);}
  function move(direction){const b=buttons(),i=b.indexOf(document.activeElement);b[(i+direction+b.length)%b.length]?.focus();}
  document.addEventListener('keydown',e=>{if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(e.key)){e.preventDefault();move(['ArrowDown','ArrowRight'].includes(e.key)?1:-1);}if(e.key==='Escape')$('back').click();});
  function poll(){const p=[...(navigator.getGamepads?.()||[])].find(p=>p?.connected);if(p){const down=p.buttons.map(b=>b.pressed),edge=n=>down[n]&&!last[n];if(edge(0))document.activeElement?.click();if(edge(1))$('back').click();if(edge(12)||edge(14))move(-1);if(edge(13)||edge(15))move(1);last=down;}requestAnimationFrame(poll);}
  setInterval(status,1500);requestAnimationFrame(poll);$('check').focus();
  status().then(initialized=>{if(initialized)window.CubbyUIReady?.();});
})();
