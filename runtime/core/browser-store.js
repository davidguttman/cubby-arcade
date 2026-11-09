/* Browser-managed game files. Checksums prove integrity, not publisher identity.
 * The trusted Store owns discovery; game manifests do not need a deployment domain.
 * Bytes stage in a private cache. One IndexedDB transaction activates a complete
 * release; generation checks prevent another tab's removal being resurrected.
 */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./game-feeds.js'):root.HandheldGameFeeds);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.HandheldBrowserStore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Feeds){
  'use strict';
  const PREFIX='/__cubby_games__/',DB_NAME='cubby-browser-games-v1',CACHE_PREFIX='cubby-game-';
  const CATALOG_CACHE='cubby-discovery-v1',MAX_BYTES=128*1024*1024,MAX_MANIFEST=256*1024;
  const ID=/^[a-z0-9][a-z0-9-]{0,79}$/,VERSION=/^[a-z0-9][a-z0-9.-]{0,79}$/;
  function safePath(name){
    if(typeof name!=='string'||!name||/[\\%?#\x00-\x1f\x7f]/.test(name)||name.endsWith(' ')||name.split('/').some(piece=>!piece||piece==='.'||piece==='..'))throw Error('Invalid game asset path');
    return name;
  }
  function downloadURL(value,base){
    if(typeof value!=='string'||!value||/[\\\x00-\x20\x7f#]/.test(value)||/%(?![0-9a-f]{2})|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)||value.startsWith('//'))throw Error('Invalid download URL');
    const absolute=/^[a-z][a-z0-9+.-]*:/i.test(value);
    if(absolute&&!/^https:\/\/[^/]/i.test(value))throw Error('HTTPS download required');
    if(!absolute&&(!base||!value.split('?')[0]||value.split('/')[0].includes(':')))throw Error('Invalid relative download URL');
    const url=new URL(value,base);
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)throw Error('HTTPS download required');
    return url.href;
  }
  function validateRelease(value,id,manifestURL){
    if(!value||Array.isArray(value)||value.schema_version!==2||value.id!==id||!ID.test(id)||value.runtime!=='web'||typeof value.version!=='string'||!VERSION.test(value.version)||value.version.includes('..'))throw Error('Invalid release identity/runtime');
    if(Object.hasOwn(value,'package')||!value.files||typeof value.files!=='object'||Array.isArray(value.files))throw Error('Expected a file release manifest');
    const entries=Object.entries(value.files),files=Object.create(null);let total=0;
    if(!entries.length||entries.length>1000)throw Error('Invalid file inventory');
    for(const [name,file] of entries){
      safePath(name);
      if(name==='manifest.json'||name.startsWith('manifest.json/'))throw Error('Reserved manifest path');
      const parts=name.split('/');for(let i=1;i<parts.length;i++)if(Object.hasOwn(value.files,parts.slice(0,i).join('/')))throw Error('Conflicting file paths');
      if(!file||Array.isArray(file)||!Number.isSafeInteger(file.size)||file.size<0||(total+=file.size)>MAX_BYTES||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid file metadata');
      files[name]={size:file.size,sha256:file.sha256,url:downloadURL(file.url,manifestURL)};
    }
    for(const key of ['entrypoint','artwork',...(value.attract!==undefined?['attract']:[])])if(!Object.hasOwn(files,safePath(value[key])))throw Error('Missing game asset');
    if(value.screenshots!==undefined&&(!Array.isArray(value.screenshots)||value.screenshots.length>12))throw Error('Invalid screenshots');
    for(const name of value.screenshots||[])if(!Object.hasOwn(files,safePath(name)))throw Error('Missing screenshot');
    return {...value,files};
  }
  function validateCatalog(entries){return Feeds.validateEntries(entries);}
  function emptyRecord(id){return {id,generation:0,active:null,releases:[]};}
  function createMetadataStore(indexedDB){
    let connection;
    function open(){
      if(!connection)connection=new Promise((resolve,reject)=>{
        if(!indexedDB){reject(Error('Browser game storage unavailable'));return;}
        const request=indexedDB.open(DB_NAME,1);
        request.onupgradeneeded=()=>request.result.createObjectStore('games',{keyPath:'id'});
        request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
        request.onerror=()=>{connection=null;reject(request.error);};
        request.onblocked=()=>{connection=null;reject(Error('Browser game storage blocked'));};
      });
      return connection;
    }
    async function read(method,key){
      const db=await open();
      return new Promise((resolve,reject)=>{
        const transaction=db.transaction('games','readonly'),request=transaction.objectStore('games')[method](key);
        let result;request.onsuccess=()=>result=request.result;
        transaction.oncomplete=()=>resolve(result);transaction.onabort=()=>reject(transaction.error||Error('Storage read aborted'));transaction.onerror=()=>{};
      });
    }
    return {
      async list(){return read('getAll');},
      async get(id){return (await read('get',id))||emptyRecord(id);},
      async change(id,generation,update){
        const db=await open();
        return new Promise((resolve,reject)=>{
          const transaction=db.transaction('games','readwrite'),store=transaction.objectStore('games'),request=store.get(id);let result,failure;
          request.onsuccess=()=>{
            try{
              const previous=request.result||emptyRecord(id);
              if(generation!==undefined&&previous.generation!==generation)throw Error('Game changed during installation');
              result=update(previous);store.put(result);
            }catch(error){failure=error;transaction.abort();}
          };
          transaction.oncomplete=()=>resolve(result);transaction.onabort=()=>reject(failure||transaction.error||Error('Storage update aborted'));transaction.onerror=()=>{};
        });
      }
    };
  }
  function context(options={}){
    const origin=options.origin||globalThis.location?.origin;
    if(!origin||new URL(origin).protocol!=='https:')throw Error('Secure browser origin required');
    return {...options,origin,fetch:options.fetch||globalThis.fetch?.bind(globalThis),crypto:options.crypto||globalThis.crypto,caches:options.caches||globalThis.caches,metadata:options.metadata||createMetadataStore(options.indexedDB||globalThis.indexedDB)};
  }
  async function readBytes(response,limit,onProgress){
    if(!response.ok||response.redirected||response.type==='opaque')throw Error('Download unavailable');
    const declared=response.headers.get('content-length');
    if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw Error('Invalid download size');
    if(!response.body)throw Error('Empty download');
    const reader=response.body.getReader(),parts=[];let size=0;
    try{
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('Download too large');parts.push(value);onProgress?.(size);}
    }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return bytes;
  }
  function mediaType(name){
    return ({html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json; charset=utf-8',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',webm:'video/webm',mp4:'video/mp4',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',wasm:'application/wasm',woff:'font/woff',woff2:'font/woff2'})[name.split('.').pop().toLowerCase()]||'application/octet-stream';
  }
  const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  const releaseBase=(id,token)=>PREFIX+id+'/'+token+'/';
  function libraryEntry(record){
    const {manifest,token}=record.active,base=releaseBase(record.id,token),asset=name=>base+name.split('/').map(encodeURIComponent).join('/');
    return {id:record.id,title:record.title||record.id,version:manifest.version,runtime:'web',entrypoint:asset(manifest.entrypoint),artwork:asset(manifest.artwork),...(manifest.attract?{attract:asset(manifest.attract)}:{})};
  }
  function createBridge(options={}){
    const ctx=context(options),listeners=new Set(),jobs=new Map(),states={};
    const state=(id,phase,details={})=>{states[id]={phase,...details};for(const listener of listeners)try{listener(structuredClone(states));}catch{/* Observer failures cannot change an install. */}};
    const feedKey=ctx.origin+'/__cubby_feed_state__';
    const fetched=new Map();
    async function readFeedState(){
      const cache=await ctx.caches.open(CATALOG_CACHE),saved=await cache.match(feedKey);
      if(!saved)return null;
      const bytes=await readBytes(saved,20*1024*1024),value=JSON.parse(new TextDecoder().decode(bytes));
      for(const [url,entries] of Object.entries(value.cache||{}))try{fetched.set(Feeds.feedURL(url),Feeds.validateEntries(entries));}catch{}
      return value;
    }
    async function writeFeedState(value){
      const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>20*1024*1024)throw Error('Feed state too large');
      const cache=await ctx.caches.open(CATALOG_CACHE);await cache.put(feedKey,new Response(text,{headers:{'Content-Type':'application/json'}}));
    }
    async function fetchCatalog(url){
      url=Feeds.feedURL(url);
      const response=await ctx.fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
      const entries=Feeds.validateEntries(JSON.parse(new TextDecoder().decode(await readBytes(response,1024*1024))));
      fetched.set(url,entries);return entries;
    }
    function selectedOffer(id,offer){
      Feeds.validateEntries([offer]);const source=Feeds.sourceOf(offer);
      if(offer.id!==id||!(fetched.get(source.feed_url)||[]).some(entry=>entry.id===id&&entry.manifest_url===source.manifest_url))throw Error('Game source not offered');
      return offer;
    }
    const bridge={
      readFeedState,writeFeedState,fetchCatalog,
      async ready(){await ctx.metadata.list();if(!ctx.caches||!ctx.crypto?.subtle)throw Error('Browser game storage unavailable');},
      async library(){return (await ctx.metadata.list()).filter(record=>record.active).map(libraryEntry);},
      install(id,options={}){
        if(typeof id!=='string'||!ID.test(id))return Promise.reject(Error('Invalid game id'));
        return startJob(id,options);
      },
      // An uninstall or reinstall, here or in another tab, invalidates a queued update.
      async update(id,{signal,offer}={}){
        if(typeof id!=='string'||!ID.test(id))throw Error('Invalid game id');
        const record=await ctx.metadata.get(id);
        if(record.active)return startJob(id,{signal,offer,generation:record.generation});
      },
      async uninstall(id){
        if(typeof id!=='string'||!ID.test(id))throw Error('Invalid game id');
        if(jobs.has(id))throw Error('Game installer busy');
        state(id,'uninstalling');
        try{
          let releases=[];
          await ctx.metadata.change(id,undefined,record=>{releases=record.releases;return {...record,generation:record.generation+1,active:null,releases:[],identities:{}};});
          // This never touches localStorage, favorites, saves or another game's bytes.
          await Promise.all(releases.map(token=>ctx.caches.delete(CACHE_PREFIX+token)));
          state(id,'uninstalled');return bridge.library();
        }catch(error){state(id,'error');throw error;}
      },
      async installStatus(){return structuredClone(states);},
      onInstallState(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
    };
    function startJob(id,jobOptions={}){
      if(jobs.has(id))return jobs.get(id);
      const job=run(id,jobOptions).catch(error=>{state(id,'error');throw error;}).finally(()=>jobs.delete(id));jobs.set(id,job);return job;
    }
    async function run(id,{signal:cancel,generation,offer:selected}={}){
      cancel?.throwIfAborted();
      const before=await ctx.metadata.get(id);
      // An uninstall/reinstall in this or another tab invalidates a queued update.
      if(generation!==undefined&&(!before.active||before.generation!==generation))return;
      state(id,'checking');
      const offer=selectedOffer(id,selected);
      const signal=AbortSignal.any([AbortSignal.timeout(120000),...(cancel?[cancel]:[])]),url=downloadURL(offer.manifest_url);
      const raw=await readBytes(await ctx.fetch(url,{redirect:'error',cache:'no-store',signal}),MAX_MANIFEST);
      signal.throwIfAborted();
      const manifest=validateRelease(JSON.parse(new TextDecoder().decode(raw)),id,url);
      const identity=m=>JSON.stringify([m.id,m.version,m.runtime,m.entrypoint,m.artwork,m.attract??null,m.screenshots??[],Object.entries(m.files).map(([path,file])=>[path,file.size,file.sha256]).sort(([a],[b])=>a.localeCompare(b))]);
      // All retained releases remain immutable, not just the active version.
      const identities={...before.identities};
      if(before.active)identities[before.active.manifest.version]=identity(before.active.manifest);
      const currentIdentity=identity(manifest);
      if(Object.hasOwn(identities,manifest.version)&&identities[manifest.version]!==currentIdentity)throw Error('Immutable release conflict');
      if(before.active&&identity(before.active.manifest)===currentIdentity){
        const current=await ctx.metadata.get(id);signal.throwIfAborted();
        if(current.generation!==before.generation)throw Error('Game changed during installation');
        state(id,'installed',{version:manifest.version});return manifest;
      }
      // A random staging identity, not the game version, keeps interrupted writes
      // and simultaneous tabs isolated. Older active sessions retain their URLs.
      const token=hex(ctx.crypto.getRandomValues(new Uint8Array(16))),name=CACHE_PREFIX+token,base=ctx.origin+releaseBase(id,token),cache=await ctx.caches.open(name);
      let committed=false,received=0;
      const total=Object.values(manifest.files).reduce((sum,file)=>sum+file.size,0);
      state(id,'downloading',{received,total});
      try{
        for(const [path,file] of Object.entries(manifest.files)){
          signal.throwIfAborted();
          const bytes=await readBytes(await ctx.fetch(file.url,{redirect:'error',cache:'no-store',signal}),file.size,n=>state(id,'downloading',{received:received+n,total}));
          signal.throwIfAborted();
          if(bytes.byteLength!==file.size||hex(await ctx.crypto.subtle.digest('SHA-256',bytes))!==file.sha256)throw Error('Download checksum/size mismatch');
          await cache.put(base+path.split('/').map(encodeURIComponent).join('/'),new Response(bytes,{headers:{'Content-Type':mediaType(path),'X-Content-Type-Options':'nosniff'}}));
          received+=file.size;state(id,'downloading',{received,total});
        }
        state(id,'verifying');
        await ctx.metadata.change(id,before.generation,record=>{signal.throwIfAborted();return {...record,title:offer.title,generation:record.generation+1,active:{token,manifest},releases:[...record.releases,token],identities:{...identities,[manifest.version]:currentIdentity}};});
        committed=true;
        // Best effort only: browsers may still evict site data. Never promise
        // durable storage or block an otherwise successful install on a prompt.
        try{Promise.resolve((options.storage||globalThis.navigator?.storage)?.persist?.()).catch(()=>{});}catch{}
        state(id,'installed',{version:manifest.version});return manifest;
      }finally{if(!committed)await ctx.caches.delete(name);}
    }
    return bridge;
  }
  async function installedResponse(request,options={}){
    const ctx=context(options),url=new URL(request.url);
    if(url.origin!==ctx.origin||!url.pathname.startsWith(PREFIX))return null;
    const missing=()=>new Response('',{status:404});
    if(!['GET','HEAD'].includes(request.method))return new Response('',{status:405});
    const parts=url.pathname.slice(PREFIX.length).split('/'),id=parts.shift(),token=parts.shift();
    if(!ID.test(id)||!token||!/^[a-f0-9]{32}$/.test(token))return missing();
    let path;try{path=parts.map(decodeURIComponent).join('/');safePath(path);}catch{return missing();}
    const record=await ctx.metadata.get(id);
    if(!record.releases.includes(token))return missing();
    const cache=await ctx.caches.open(CACHE_PREFIX+token),key=ctx.origin+releaseBase(id,token)+path.split('/').map(encodeURIComponent).join('/');
    let response=await cache.match(key);
    if(!response)return missing();
    // Inject host controls only on delivery; verified cached publisher bytes stay
    // unchanged. This is the same trusted-game model as native HTML delivery.
    if(/\.html?$/i.test(path)){
      let html=await response.text();
      const tag='<script src="/runtime/core/handheld-embed.js"></script><script src="/runtime/core/preferences.js"></script><script data-cubby-controller src="/runtime/core/host-osd.js"></script><script data-handheld-system src="/runtime/core/game-shell.js"></script><script data-cubby-profile src="/runtime/core/profiles.js"></script>';
      if(!html.includes(tag)){const match=/<!doctype[^>]*>/i.exec(html),at=match?match.index+match[0].length:0;html=html.slice(0,at)+tag+html.slice(at);}
      response=new Response(html,{headers:response.headers});
    }
    if(request.method==='HEAD')return new Response(null,{status:response.status,headers:response.headers});
    const range=request.headers.get('range');
    if(range){
      // Media elements request byte ranges, including when seeking offline.
      const bytes=new Uint8Array(await response.arrayBuffer()),match=/^bytes=(\d*)-(\d*)$/.exec(range),headers=new Headers(response.headers),size=bytes.byteLength;
      let start,end;
      if(match&&(match[1]||match[2])){
        start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
        end=match[1]?(match[2]?Math.min(Number(match[2]),size-1):size-1):size-1;
      }
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){headers.set('Content-Range','bytes */'+size);return new Response(null,{status:416,headers});}
      headers.set('Content-Range','bytes '+start+'-'+end+'/'+size);headers.set('Content-Length',String(end-start+1));headers.set('Accept-Ranges','bytes');
      return new Response(bytes.slice(start,end+1),{status:206,headers});
    }
    return response;
  }
  // Root service-worker wrapper supplies a content/versioned shell allowlist.
  // Never substitute shell HTML or network downloads for missing installed files.
  function attachWorker(scope,options={}){
    const paths=new Set(options.shellPaths||[]),shellName='cubby-shell-'+(options.shellVersion||'v1');
    const ctx=context({origin:scope.location.origin,indexedDB:scope.indexedDB,caches:scope.caches,fetch:scope.fetch.bind(scope),crypto:scope.crypto});
    scope.addEventListener('install',event=>event.waitUntil((async()=>{
      const cache=await ctx.caches.open(shellName);if(paths.size)await cache.addAll([...paths]);await scope.skipWaiting();
    })()));
    scope.addEventListener('activate',event=>event.waitUntil(scope.clients.claim()));
    scope.addEventListener('fetch',event=>{
      const request=event.request,url=new URL(request.url);
      if(url.origin!==ctx.origin)return;
      if(url.pathname.startsWith(PREFIX)){
        event.respondWith(installedResponse(request,ctx).catch(()=>new Response('',{status:503})));return;
      }
      if(request.method!=='GET'||!paths.has(url.pathname))return;
      event.respondWith((async()=>{
        const cache=await ctx.caches.open(shellName),key=ctx.origin+url.pathname;
        try{const response=await ctx.fetch(request);if(!response.ok)throw Error('Shell unavailable');await cache.put(key,response.clone());return response;}
        catch(error){const saved=await cache.match(key);if(saved)return saved;throw error;}
      })());
    });
  }
  return {createBridge,createMetadataStore,validateRelease,validateCatalog,installedResponse,attachWorker,PREFIX};
});
