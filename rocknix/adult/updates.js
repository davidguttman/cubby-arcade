(() => {
  'use strict';
  const token=document.querySelector('meta[name="cubby-session"]').content;
  const $=id=>document.getElementById(id);
  const ACTIONS={idle:['check','Check for updates'],rolled_back:['check','Check for updates'],error:['check','Try again'],
    available:['download','Download update'],staged:['apply','Install and restart'],
    checking:[null,'Checking…'],downloading:[null,'Downloading…'],trial:[null,'Restarting…']};
  const TONES={available:'warn',staged:'warn',rolled_back:'bad',error:'bad'};
  let pending=false, checked=false, next=null, last=[];
  async function request(action) {
    const r=await fetch('/api/update',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Cubby-Session':token},body:JSON.stringify({action})});
    const value=await r.json(); if(!r.ok) throw Error(value.error||'Update unavailable'); return value;
  }
  function say(text,tone) { $('status').textContent=text; if(tone)$('status').dataset.tone=tone; else delete $('status').dataset.tone; }
  async function status() {
    try {
      const r=await request('status');
      const labels={unconfigured:'Updates are not configured on this installation.',
        idle:checked?'Cubby is up to date.':'Cubby is ready. Check for updates when online.',
        checking:'Checking for updates…',available:'An update is available.',downloading:'Downloading and verifying update…',
        staged:'Update verified. Install when ready.',trial:'Restarting Cubby…',
        rolled_back:'The last update could not start. The previous Cubby was restored.',error:r.error||'Update failed. Please retry.'};
      say(labels[r.phase]||r.phase,TONES[r.phase]||(r.phase==='idle'&&checked?'ok':''));
      document.body.classList.toggle('busy',r.phase in {checking:1,downloading:1,trial:1});
      // Installations from before this field report only the incoming version.
      const incoming=['available','staged'].includes(r.phase)?r.version:null;
      $('version').textContent='Cubby'+(incoming?' '+incoming:r.installed?' '+r.installed:'');
      const [action,label]=ACTIONS[r.phase]||[null,''];
      next=action;
      // Busy phases keep focus on this button, so the next step is one press away.
      $('action').hidden=!label;
      if($('action').textContent!==label)$('action').textContent=label;
      $('action').setAttribute('aria-disabled',String(!action));
      if($('action').hidden&&document.activeElement!==$('back'))$('back').focus();
      return true;
    } catch(e) { say(e.message,'bad'); return false; }
  }
  $('action').onclick=async()=>{
    if(pending||!next)return; pending=true;
    if(next==='check')checked=true;
    try { await request(next); }
    catch(e){say(e.message,'bad');}
    finally {pending=false; await status();}
  };
  $('back').onclick=()=>location.replace('/#options');
  function buttons(){return [...document.querySelectorAll('button')].filter(b=>!b.hidden);}
  function move(direction){const b=buttons(),i=b.indexOf(document.activeElement);b[(i+direction+b.length)%b.length]?.focus();}
  document.addEventListener('keydown',e=>{if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(e.key)){e.preventDefault();move(['ArrowDown','ArrowRight'].includes(e.key)?1:-1);}if(e.key==='Escape')$('back').click();});
  function poll(){const p=[...(navigator.getGamepads?.()||[])].find(p=>p?.connected);if(p){const down=p.buttons.map(b=>b.pressed),edge=n=>down[n]&&!last[n];if(edge(0))document.activeElement?.click();if(edge(1))$('back').click();if(edge(12)||edge(14))move(-1);if(edge(13)||edge(15))move(1);last=down;}requestAnimationFrame(poll);}
  setInterval(status,1500);requestAnimationFrame(poll);$('action').focus();
  status().then(initialized=>{if(initialized)window.CubbyUIReady?.();});
})();
