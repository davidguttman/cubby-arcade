const {app,BrowserWindow,protocol,ipcMain}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {assetPath,gameScope,SaveStore,GameLibrary}=require('./host.cjs');
protocol.registerSchemesAsPrivileged([{scheme:'hub',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const smoke=process.argv.includes('--smoke');
if(process.env.HUB_USER_DATA)app.setPath('userData',path.resolve(process.env.HUB_USER_DATA));
else if(smoke)app.setPath('userData',path.join(app.getPath('temp'),'handheld-hub-smoke-profile'));
app.whenReady().then(async()=>{
  const site=app.isPackaged?path.join(process.resourcesPath,'web'):path.join(__dirname,'../.cache/web');
  const store=new SaveStore(path.join(app.getPath('userData'),'saves'));
  const library=new GameLibrary(site,process.env.HUB_GAMES_DIR?path.resolve(process.env.HUB_GAMES_DIR):path.join(app.getPath('userData'),'games'));
  protocol.handle('hub',async request=>{
    try{
      const url=new URL(request.url);
      if(url.pathname==='/report'&&request.method==='POST')return new Response(null,{status:204});
      if(request.method!=='GET'&&request.method!=='HEAD')return new Response(null,{status:405});
      assetPath(request.url,site);
      const file=library.file(request.url);
      let data=['/library','/catalog'].includes(url.pathname)?Buffer.from(JSON.stringify(library.entries())):await fs.readFile(file);
      if(url.pathname.startsWith('/games/')&&path.extname(file).toLowerCase()==='.html'){
        let html=data.toString('utf8');const tag='<script src="/runtime/core/preferences.js"></script><script data-handheld-system src="/runtime/core/game-shell.js"></script>';
        if(!html.includes(tag)){const match=/<!doctype[^>]*>/i.exec(html),at=match?match.index+match[0].length:0;data=Buffer.from(html.slice(0,at)+tag+html.slice(at));}
      }
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.webm':'video/webm','.mp4':'video/mp4','.mp3':'audio/mpeg','.png':'image/png'};
      const headers={'Content-Type':mime[path.extname(file)]||(['/library','/catalog'].includes(url.pathname)?'application/json':'application/octet-stream'),'Accept-Ranges':'bytes','Cache-Control':'no-store'};
      let body=data,status=200;
      const range=request.headers.get('range');
      if(range){
        const m=/^bytes=(\d+)-(\d*)$/.exec(range);
        const start=m?Number(m[1]):-1,end=m&&m[2]?Math.min(Number(m[2]),data.length-1):data.length-1;
        if(!m||!Number.isSafeInteger(start)||start<0||start> end||start>=data.length)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${data.length}`}});
        body=data.subarray(start,end+1);status=206;headers['Content-Range']=`bytes ${start}-${end}/${data.length}`;
      }
      headers['Content-Length']=String(body.length);
      return new Response(request.method==='HEAD'?null:body,{status,headers});
    }catch{return new Response(null,{status:404});}
  });
  ipcMain.on('hub:save',(event,message)=>{
    try{
      if(event.senderFrame!==event.sender.mainFrame)throw Error('Main game frame required');
      const game=gameScope(event.senderFrame.url);
      if(message.game!==game)throw Error('Save scope mismatch');
      if(!['get','set','remove'].includes(message.operation))throw Error('Invalid operation');
      event.returnValue={value:store[message.operation](game,message.key,message.value)??null};
    }catch{event.returnValue={error:'Save operation rejected'};}
  });
  const win=new BrowserWindow({show:!smoke,width:960,height:640,fullscreen:!smoke,autoHideMenuBar:true,backgroundColor:'#101614',
    webPreferences:{offscreen:smoke,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.removeMenu();
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{try{assetPath(url,site);}catch{event.preventDefault();}});
  win.webContents.on('will-redirect',(event,url)=>{try{assetPath(url,site);}catch{event.preventDefault();}});
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  win.on('blur',()=>win.webContents.executeJavaScript('document.querySelectorAll("video").forEach(v=>v.pause()); window.handheldAudio?.suspend();').catch(()=>{}));
  win.on('focus',()=>win.webContents.executeJavaScript('document.querySelectorAll("video").forEach(v=>v.play().catch(()=>{})); window.handheldAudio?.resume().catch(()=>{});').catch(()=>{}));
  await win.loadURL('hub://app/');
  if(smoke){
    const output=process.env.HUB_SMOKE_DIR;
    try{
      await new Promise(resolve=>setTimeout(resolve,1500));
      const hub=await require('./hub-smoke.cjs').checkHub(win,output);
      const library=await win.webContents.executeJavaScript('fetch("/library").then(r=>r.json())');
      if(!library.length)throw Error('Empty smoke library');
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label=library]').click();document.querySelector('.game-card').click();`);
      await new Promise(resolve=>setTimeout(resolve,3000));
      const trailer=await win.webContents.executeJavaScript('[...document.querySelectorAll("video")].map(v=>({time:v.currentTime,error:v.error?.message,paused:v.paused}))');
      if(output){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'title.png'),(await win.webContents.capturePage()).toPNG());}
      await win.webContents.executeJavaScript(`document.querySelector('.play-game').click();`);
      await new Promise(resolve=>setTimeout(resolve,1000));
      const report=await win.webContents.executeJavaScript(`(()=>{const p=HandheldPlatform.createPlatform(window.HandheldPlatformOptions);const s=p.saves('line-cutter');s.set('desktop-smoke',{ok:true});return {kind:p.kind,save:s.get('desktop-smoke'),node:typeof require,url:location.href,canvas:!!document.getElementById('screen'),video:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,error:v.error?.message,paused:v.paused}))};})()`);
      if(output){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'desktop.png'),(await win.webContents.capturePage()).toPNG());await fs.writeFile(path.join(output,'report.json'),JSON.stringify({hub,library,trailer,report},null,2));}
      console.log(JSON.stringify({hub,library,trailer,report}));
      if(report.kind!=='desktop'||!report.save?.ok||report.node!=='undefined'||!report.canvas||report.video.length||!report.url.endsWith(library[0].entrypoint)||!trailer.some(v=>v.time>0&&!v.paused&&!v.error))throw Error('Desktop bridge smoke failed');
      // Exercise the host-owned menu, not the game's optional Quit callback.
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      await new Promise(resolve=>setTimeout(resolve,200));
      if(!await win.webContents.executeJavaScript('HandheldGameShell.isOpen()'))throw Error('System menu did not open');
      if(output)await fs.writeFile(path.join(output,'system-menu.png'),(await win.webContents.capturePage()).toPNG());
      // Pointer activation on the resume picture must return to the same game.
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Resume game"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));`);
      if(await win.webContents.executeJavaScript('HandheldGameShell.isOpen()'))throw Error('System menu resume failed');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      await new Promise(resolve=>setTimeout(resolve,400));
      if(!await win.webContents.executeJavaScript('!!document.querySelector(".game-card")'))throw Error('System menu did not return to library');
      app.exit(0);
    }catch(error){console.error(error);app.exit(1);}
  }
});
app.on('window-all-closed',()=>app.quit());
