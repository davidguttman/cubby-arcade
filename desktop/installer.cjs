/* Native game installation: HTTPS releases, verified bounded ZIPs, atomic activation.
 * Package checksums prove integrity, not publisher identity. Catalog is trusted by the host.
 */
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const yauzl=require('yauzl');
const {validateCatalog}=require('./cloud.cjs');
const MAX_BYTES=128*1024*1024,MAX_MANIFEST=256*1024;
const idPattern=/^[a-z0-9][a-z0-9-]{0,79}$/,versionPattern=/^[a-z0-9][a-z0-9.-]{0,79}$/;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function safePath(name){if(typeof name!=='string'||!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid package path');return name;}
function httpsURL(value){if(typeof value!=='string')throw Error('Invalid download URL');const url=new URL(value);if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)throw Error('HTTPS download required');return url;}
function validateRelease(m,id){
 if(!m||m.schema_version!==1||m.id!==id||!idPattern.test(id)||m.runtime!=='web'||typeof m.version!=='string'||!versionPattern.test(m.version)||m.version.includes('..'))throw Error('Invalid release identity/runtime');
 safePath(m.entrypoint);const p=m.package;if(!p||!Number.isSafeInteger(p.size)||p.size<=0||p.size>MAX_BYTES||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256))throw Error('Invalid release package');httpsURL(p.url);return m;
}
function validateInventory(m,release,digests){
 if(!m||m.schema_version!==1||m.runtime!=='web'||m.id!==release.id||m.version!==release.version||m.entrypoint!==release.entrypoint||!m.files||Array.isArray(m.files))throw Error('Package identity mismatch');
 const names=Object.keys(m.files);if(!names.length||names.length>1000||names.length!==Object.keys(digests).length-1)throw Error('Package inventory mismatch');
 for(const name of names){safePath(name);if(name==='manifest.json'||typeof m.files[name]!=='string'||!/^[a-f0-9]{64}$/.test(m.files[name])||digests[name]!==m.files[name])throw Error('Package checksum/inventory mismatch');}
 for(const name of ['entrypoint','artwork',...(m.attract!==undefined?['attract']:[])])if(!Object.hasOwn(m.files,safePath(m[name])))throw Error('Missing game asset');
 return m;
}
async function readBounded(stream,limit,signal){let size=0;const parts=[];for await(const chunk of stream){signal?.throwIfAborted();size+=chunk.length;if(size>limit)throw Error('Content too large');parts.push(Buffer.from(chunk));}return Buffer.concat(parts);}
async function download(fetcher,url,limit,signal,onProgress){
 const response=await fetcher(httpsURL(url).href,{redirect:'error',cache:'no-store',signal});
 if(!response.ok||response.redirected)throw Error('Download unavailable');
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw Error('Invalid download size');
 let size=0;const parts=[];if(!response.body)throw Error('Empty download');
 for await(const chunk of response.body){signal.throwIfAborted();size+=chunk.length;if(size>limit)throw Error('Download too large');parts.push(Buffer.from(chunk));onProgress?.(size);}
 return Buffer.concat(parts);
}
async function extract(buffer,directory,release){
 const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true,autoClose:true,strictFileNames:true},(e,z)=>e?reject(e):resolve(z)));
 const digests=Object.create(null);let count=0,total=0;
 const signal=AbortSignal.timeout(120000);
 await new Promise((resolve,reject)=>{
  let settled=false;const fail=e=>{if(settled)return;settled=true;zip.close();reject(e);};
  zip.on('error',fail);zip.on('end',()=>{if(!settled){settled=true;resolve();}});
  zip.on('entry',entry=>{(async()=>{
   const name=safePath(entry.fileName),mode=(entry.externalFileAttributes>>>16)&0o170000;
   if(++count>1001||Object.hasOwn(digests,name)||mode===0o120000||(mode!==0&&mode!==0o100000)||!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||(total+=entry.uncompressedSize)>MAX_BYTES)throw Error('Invalid/oversized ZIP inventory');
   const limit=name==='manifest.json'?Math.min(MAX_MANIFEST,entry.uncompressedSize):entry.uncompressedSize;
   const stream=await new Promise((r,j)=>zip.openReadStream(entry,(e,s)=>e?j(e):r(s)));
   const bytes=await readBounded(stream,limit,signal);if(bytes.length!==entry.uncompressedSize)throw Error('ZIP size mismatch');
   digests[name]=hash(bytes);const target=path.join(directory,name);await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.writeFile(target,bytes,{mode:0o444});
   zip.readEntry();
  })().catch(fail);});zip.readEntry();
 });
 if(!Object.hasOwn(digests,'manifest.json'))throw Error('Missing package manifest');
 const manifest=validateInventory(JSON.parse(await fsp.readFile(path.join(directory,'manifest.json'),'utf8')),release,digests);
 return manifest;
}
function noSymlinks(root,target){
 let current=root;for(const piece of path.relative(root,target).split(path.sep)){if(!piece)continue;if(piece==='..')throw Error('Path outside games');current=path.join(current,piece);try{if(fs.lstatSync(current).isSymbolicLink())throw Error('Symlinked install path');}catch(e){if(e.code!=='ENOENT')throw e;}}
}
class GameInstaller{
 constructor(library,options={}){this.library=library;this.fetch=options.fetch||globalThis.fetch;this.canActivate=options.canActivate||(()=>true);this.onChange=options.onChange||(()=>{});this.catalog=[];this.states={};this.jobs=new Map();this.pending=new Map();this.checking=null;}
 setCatalog(entries){this.catalog=validateCatalog(JSON.stringify(entries));}
 status(){return structuredClone(this.states);}
 state(id,phase,details={}){this.states[id]={phase,...details};this.onChange(this.status());}
 install(id){
  if(typeof id!=='string'||!idPattern.test(id))return Promise.reject(Error('Invalid game id'));
  if(this.jobs.has(id))return this.jobs.get(id);
  const entry=this.catalog.find(e=>e.id===id&&e.manifest_url);if(!entry)return Promise.reject(Error('Game not offered'));
  const job=this.run(entry).catch(e=>{this.state(id,'error');throw e;}).finally(()=>this.jobs.delete(id));this.jobs.set(id,job);return job;
 }
 async run(entry){
  const id=entry.id;this.state(id,'checking');const signal=AbortSignal.timeout(120000);
  const release=validateRelease(JSON.parse((await download(this.fetch,entry.manifest_url,MAX_MANIFEST,signal)).toString('utf8')),id);
  const installed=this.library.entries().find(e=>e.id===id);
  if(installed?.version===release.version){this.state(id,'installed',{version:release.version});return installed;}
  this.state(id,'downloading',{received:0,total:release.package.size});
  const bytes=await download(this.fetch,release.package.url,release.package.size,signal,received=>this.state(id,'downloading',{received,total:release.package.size}));
  if(bytes.length!==release.package.size||hash(bytes)!==release.package.sha256)throw Error('Download checksum/size mismatch');
  return this.stage(bytes,release);
 }
 async stage(bytes,release){
  const root=this.library.games;await fsp.mkdir(root,{recursive:true});
  // The app owns this root; reject symlinked game/release paths before writes.
  if((await fsp.lstat(root)).isSymbolicLink())throw Error('Symlinked games root');
  const temporary=await fsp.mkdtemp(path.join(root,'.install-'));
  try{
   this.state(release.id,'verifying');const manifest=await extract(bytes,temporary,release);
   const game=path.join(root,release.id),releases=path.join(game,'releases'),target=path.join(releases,release.version);
   noSymlinks(root,target);await fsp.mkdir(releases,{recursive:true});
   if(fs.existsSync(target)){
    const old=await fsp.readFile(path.join(target,'manifest.json'),'utf8');
    if(old!==await fsp.readFile(path.join(temporary,'manifest.json'),'utf8'))throw Error('Immutable release conflict');
    // Validate existing bytes too, rather than activating a corrupt old directory.
    for(const [name,digest] of Object.entries(manifest.files))if(hash(await fsp.readFile(path.join(target,name)))!==digest)throw Error('Existing release checksum mismatch');
   }else await fsp.rename(temporary,target);
   this.pending.set(release.id,{game,target,release});this.state(release.id,'pending',{version:release.version});
   await this.activatePending();return manifest;
  }finally{await fsp.rm(temporary,{recursive:true,force:true});}
 }
 async activatePending(){
  // Synchronous check + pointer replacement prevents navigation changing state
  // between the idle check and activation. No game page ever sees mixed assets.
  if(!this.canActivate())return;
  for(const [id,{game,release}] of this.pending){
   const pointer=path.join(game,'.current-'+crypto.randomBytes(6).toString('hex'));
   try{fs.symlinkSync('releases/'+release.version,pointer);fs.renameSync(pointer,path.join(game,'current'));this.pending.delete(id);this.state(id,'installed',{version:release.version});}
   finally{fs.rmSync(pointer,{force:true});}
  }
 }
 checkUpdates(){
  if(this.checking)return this.checking;
  this.checking=(async()=>{await this.activatePending();const ids=new Set(this.library.entries().map(e=>e.id));for(const entry of this.catalog)if(ids.has(entry.id)&&entry.manifest_url){try{await this.install(entry.id);}catch{/* Installed release remains playable; next hub entry retries. */}}})().finally(()=>this.checking=null);return this.checking;
 }
 async seedBundle(){
  // Import into a sibling staging root, then expose the complete library once.
  // This preserves all bundled games if a copy fails or the app exits mid-import.
  if(this.library.managed())return;
  const entries=this.library.entries();if(!entries.length)return;
  const catalog=JSON.parse(await fsp.readFile(path.join(this.library.site,'catalog'),'utf8'));
  if(entries.some(entry=>!catalog.some(e=>e.id===entry.id&&e.manifest_url)))return; // Legacy bundle, no install archives.
  const parent=path.dirname(this.library.games);await fsp.mkdir(parent,{recursive:true});
  const staged=await fsp.mkdtemp(path.join(parent,'.bundle-'));
  try{
   for(const entry of entries){
    const base=path.join(this.library.site,'store',entry.id),release=validateRelease(JSON.parse(await fsp.readFile(path.join(base,'manifest.json'),'utf8')),entry.id);
    const name=path.posix.basename(new URL(release.package.url).pathname);const bytes=await fsp.readFile(path.join(base,release.version,name));
    if(bytes.length!==release.package.size||hash(bytes)!==release.package.sha256)throw Error('Invalid bundled archive');
    const game=path.join(staged,entry.id),directory=path.join(game,'releases',release.version);await fsp.mkdir(directory,{recursive:true});
    await extract(bytes,directory,release);await fsp.symlink('releases/'+release.version,path.join(game,'current'));
   }
   await fsp.rename(staged,this.library.games);
  }finally{await fsp.rm(staged,{recursive:true,force:true});}
 }
}
module.exports={GameInstaller,validateRelease,extract,download,MAX_BYTES};
