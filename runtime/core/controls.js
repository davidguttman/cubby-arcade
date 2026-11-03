/* Pictorial pointer/touch controls. The same semantic input is used by all hosts. */
(function(root){
  'use strict';
  const shapes={left:'M18 3 6 12l12 9Z',right:'m6 3 12 9-12 9Z',up:'m3 18 9-12 9 12Z',down:'m3 6 9 12 9-12Z',
    exit:'M11 3 1 12l10 9v-6h11V9H11Z'};
  const glyphs={a:'A',b:'B',x:'X',y:'Y',start:'+',select:'\u2212'};
  function createControls(input,mode){
    const bar=document.createElement('nav');bar.className='hub-controls'+(mode==='game'?' game-controls':'');bar.setAttribute('aria-label','Game controls');
    const list=mode==='game'?['exit','left','up','down','right','a','b','x','y','select','start']:mode==='title'?['exit','start']:['left','start','right'];
    list.forEach(button=>{
      const node=document.createElement('button');node.type='button';node.setAttribute('aria-label',button);
      node.className='control-'+button+(button==='exit'?' back':'');
      if(glyphs[button])node.textContent=glyphs[button];
      else node.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+shapes[button]+'"/></svg>';
      input.attachPointer(node,()=>button);
      // Keyboard activation is handled by the shared keyboard input, not click.
      bar.appendChild(node);
    });
    const preferences=input.preferences;
    const media=root.matchMedia && root.matchMedia('(any-pointer: coarse)');
    const update=()=>{bar.hidden=!preferences.showTouchControls(root);bar.style.display=bar.hidden?'none':'';};
    const unsubscribe=preferences.subscribe(update);
    if(media && media.addEventListener)media.addEventListener('change',update);
    update();document.body.appendChild(bar);
    return ()=>{unsubscribe();if(media && media.removeEventListener)media.removeEventListener('change',update);bar.remove();};
  }
  root.HandheldControls={createControls};
})(globalThis);
