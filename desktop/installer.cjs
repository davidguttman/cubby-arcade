/* Native game installation: HTTPS file/ZIP releases and atomic activation.
 * Package checksums prove integrity, not publisher identity. Catalog is trusted by the host.
 */
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const yauzl=require('yauzl');
const {validateCatalog}=require('./cloud.cjs');
const {safePackagePath,validatePackagePaths}=require('./host.cjs');
const MAX_BYTES=128*1024*1024,MAX_MANIFEST=256*1024;
const idPattern=/^[a-z0-9][a-z0-9-]{0,79}$/,versionPattern=/^[a-z0-9][a-z0-9.-]{0,79}$/;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const safePath=safePackagePath;
function httpsURL(value){if(typeof value!=='string')throw Error('Invalid download URL');const url=new URL(value);if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)throw Error('HTTPS download required');return url;}
function downloadURL(value,manifestURL){
 if(typeof value!=='string'||!value||/[\\\x00-\x20\x7f#]/.test(value)||/%(?![0-9a-f]{2})|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)||value.startsWith('//'))throw Error('Invalid download URL');
 const absolute=/^[a-z][a-z0-9+.-]*:/i.test(value);
 if(absolute){if(!/^https:\/\/[^/]/i.test(value)||/^https:\/\/[^/?]*@/i.test(value))throw Error('HTTPS download required');return httpsURL(value).href;}
 const pathname=value.split('?')[0];
 if(!pathname||pathname.split('/')[0].includes(':')||!manifestURL)throw Error('Relative download URL requires the manifest URL');
 return httpsURL(new URL(value,downloadURL(manifestURL)).href).href;
}
function validateRelease(m,id,manifestURL){
 if(!m||Array.isArray(m)||![1,2].includes(m.schema_version)||m.id!==id||!idPattern.test(id)||m.runtime!=='web'||typeof m.version!=='string'||!versionPattern.test(m.version)||m.version.includes('..'))throw Error('Invalid release identity/runtime');
 safePath(id);safePath(m.version);
 safePath(m.entrypoint);
 if(m.schema_version===1){
  if(Object.hasOwn(m,'files'))throw Error('Ambiguous release manifest');
  const p=m.package;if(!p||!Number.isSafeInteger(p.size)||p.size<=0||p.size>MAX_BYTES||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256))throw Error('Invalid release package');downloadURL(p.url,manifestURL);
 }else{
  if(Object.hasOwn(m,'package')||!m.files||typeof m.files!=='object'||Array.isArray(m.files))throw Error('Invalid file release');
  const names=Object.keys(m.files);if(!names.length||names.length>1000)throw Error('Invalid file inventory');
  validatePackagePaths(['manifest.json',...names]);
  let total=0;
  for(const name of names){
   safePath(name);if(/[%?#\x00-\x1f\x7f]/.test(name)||name.endsWith(' '))throw Error('Invalid file path');
   if(name==='manifest.json'||name.startsWith('manifest.json/'))throw Error('Reserved manifest path');
   const parts=name.split('/');for(let i=1;i<parts.length;i++)if(Object.hasOwn(m.files,parts.slice(0,i).join('/')))throw Error('Conflicting file paths');
   const file=m.files[name];if(!file||typeof file!=='object'||Array.isArray(file)||!Number.isSafeInteger(file.size)||file.size<0||(total+=file.size)>MAX_BYTES||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid file metadata');downloadURL(file.url,manifestURL);
  }
  for(const name of ['entrypoint','artwork',...(m.attract!==undefined?['attract']:[])])if(!Object.hasOwn(m.files,safePath(m[name])))throw Error('Missing game asset');
  if(m.screenshots!==undefined&&(!Array.isArray(m.screenshots)||m.screenshots.length>12))throw Error('Invalid screenshots');
  for(const name of m.screenshots||[])if(!Object.hasOwn(m.files,safePath(name)))throw Error('Missing screenshot');
  if(Buffer.byteLength(JSON.stringify(m))>MAX_MANIFEST)throw Error('Manifest too large');
 }
 if(manifestURL){
  if(m.schema_version===1)return {...m,package:{...m.package,url:downloadURL(m.package.url,manifestURL)}};
  return {...m,files:Object.fromEntries(Object.entries(m.files).map(([name,file])=>[name,{...file,url:downloadURL(file.url,manifestURL)}]))};
 }
 return m;
}
// Disk/host inventory stays schema 1; download locations are not game identity.
function fileInventory(release){return {schema_version:1,id:release.id,version:release.version,runtime:release.runtime,entrypoint:release.entrypoint,artwork:release.artwork,...(release.attract!==undefined?{attract:release.attract}:{}),...(release.screenshots!==undefined?{screenshots:release.screenshots}:{}),files:Object.fromEntries(Object.entries(release.files).map(([name,file])=>[name,file.sha256]))};}
function sameInventory(a,b){
 const canonical=m=>JSON.stringify([m.schema_version,m.id,m.version,m.runtime,m.entrypoint,m.artwork,m.attract??null,m.screenshots??[],Object.entries(m.files||{}).sort(([a],[b])=>a.localeCompare(b))]);
 return canonical(a)===canonical(b);
}
function validateInventory(m,release,digests){
 if(!m||m.schema_version!==1||m.runtime!=='web'||m.id!==release.id||m.version!==release.version||m.entrypoint!==release.entrypoint||!m.files||Array.isArray(m.files))throw Error('Package identity mismatch');
 const names=Object.keys(m.files);if(!names.length||names.length>1000||names.length!==Object.keys(digests).length-1)throw Error('Package inventory mismatch');
 validatePackagePaths(['manifest.json',...names]);
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
   validatePackagePaths([...Object.keys(digests),name]);
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
async function diskManifest(root,directory){
 const file=path.join(directory,'manifest.json');noSymlinks(root,file);
 const stat=await fsp.lstat(file);if(!stat.isFile()||stat.size>MAX_MANIFEST)throw Error('Invalid installed manifest');
 return JSON.parse(await fsp.readFile(file,'utf8'));
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
 // Removal is synchronous inside this async API: navigation, update discovery,
 // and installs cannot interleave between the safety check and disk removal.
 async uninstall(id){
  if(typeof id!=='string'||!idPattern.test(id))throw Error('Invalid game id');
  if(!this.canActivate())throw Error('Return to hub before uninstalling');
  if(this.checking||this.jobs.has(id)||this.pending.has(id))throw Error('Game installer busy');
  const root=this.library.games,game=path.join(root,id);
  if(fs.lstatSync(root).isSymbolicLink())throw Error('Symlinked games root');
  noSymlinks(root,path.join(game,'releases'));
  // A valid managed current selector proves ownership; do not remove arbitrary
  // directories or follow a symlink supplied in place of a managed game.
  const {directory}=this.library.release(id);noSymlinks(root,directory);
  this.state(id,'uninstalling');
  try{fs.rmSync(game,{recursive:true});this.state(id,'uninstalled');}
  catch(error){this.state(id,'error');throw error;}
  return this.library.entries();
 }
 async run(entry){
  const id=entry.id;this.state(id,'checking');const signal=AbortSignal.timeout(120000);
  const release=validateRelease(JSON.parse((await download(this.fetch,entry.manifest_url,MAX_MANIFEST,signal)).toString('utf8')),id,entry.manifest_url);
  if(release.schema_version===2)return this.stageFiles(release,signal);
  const installed=this.library.entries().find(e=>e.id===id);
  if(installed?.version===release.version){this.state(id,'installed',{version:release.version});return installed;}
  this.state(id,'downloading',{received:0,total:release.package.size});
  const bytes=await download(this.fetch,release.package.url,release.package.size,signal,received=>this.state(id,'downloading',{received,total:release.package.size}));
  if(bytes.length!==release.package.size||hash(bytes)!==release.package.sha256)throw Error('Download checksum/size mismatch');
  return this.stage(bytes,release);
 }
 async stage(bytes,release){
  return this.stageRelease(release,temporary=>extract(bytes,temporary,release));
 }
 async stageFiles(release,signal){
  const manifest=fileInventory(release),total=Object.values(release.files).reduce((sum,file)=>sum+file.size,0);let received=0;
  // Resolve only the host's active release. Individual local files are verified
  // again before reuse, even when its inventory advertises the expected hash.
  let previous;try{previous=this.library.release(release.id);}catch{}
  return this.stageRelease(release,async temporary=>{
   const target=path.join(this.library.games,release.id,'releases',release.version);
   noSymlinks(this.library.games,target);
   if(fs.existsSync(target)&&!sameInventory(await diskManifest(this.library.games,target),manifest))throw Error('Immutable release conflict');
   this.state(release.id,'downloading',{received,total});
   for(const [name,file] of Object.entries(release.files)){
    signal.throwIfAborted();let bytes;
    if(previous?.manifest.files[name]===file.sha256){
     try{
      const source=path.join(previous.directory,name);noSymlinks(this.library.games,source);
      const stat=await fsp.lstat(source);if(stat.isFile()&&stat.size===file.size){const local=await fsp.readFile(source);if(hash(local)===file.sha256)bytes=local;}
     }catch{/* Missing, changed or symlinked bytes must come from the release. */}
    }
    if(bytes===undefined)bytes=await download(this.fetch,file.url,file.size,signal,n=>this.state(release.id,'downloading',{received:received+n,total}));
    if(bytes.length!==file.size||hash(bytes)!==file.sha256)throw Error('Download checksum/size mismatch');
    const destination=path.join(temporary,name);await fsp.mkdir(path.dirname(destination),{recursive:true});await fsp.writeFile(destination,bytes,{mode:0o444});
    received+=file.size;this.state(release.id,'downloading',{received,total});
   }
   const metadata=JSON.stringify(manifest);if(Buffer.byteLength(metadata)>MAX_MANIFEST)throw Error('Manifest too large');
   await fsp.writeFile(path.join(temporary,'manifest.json'),metadata,{mode:0o444});return manifest;
  });
 }
 async stageRelease(release,prepare){
  const root=this.library.games;await fsp.mkdir(root,{recursive:true});
  // The app owns this root; reject symlinked game/release paths before writes.
  if((await fsp.lstat(root)).isSymbolicLink())throw Error('Symlinked games root');
  const temporary=await fsp.mkdtemp(path.join(root,'.install-'));
  try{
   const manifest=await prepare(temporary);this.state(release.id,'verifying');
   const game=path.join(root,release.id),releases=path.join(game,'releases'),target=path.join(releases,release.version);
   noSymlinks(root,target);await fsp.mkdir(releases,{recursive:true});
   if(fs.existsSync(target)){
    if(!sameInventory(await diskManifest(root,target),manifest))throw Error('Immutable release conflict');
    // Validate existing bytes too, rather than activating a corrupt old directory.
    for(const [name,digest] of Object.entries(manifest.files)){const existing=path.join(target,name);noSymlinks(root,existing);if(hash(await fsp.readFile(existing))!==digest)throw Error('Existing release checksum mismatch');}
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
   try{fs.writeFileSync(pointer,JSON.stringify({version:release.version})+'\n',{flag:'wx',mode:0o600});fs.renameSync(pointer,path.join(game,'current.json'));this.pending.delete(id);this.state(id,'installed',{version:release.version});}
   finally{fs.rmSync(pointer,{force:true});}
  }
 }
 checkUpdates(){
  if(this.checking)return this.checking;
  this.checking=(async()=>{await this.activatePending();const ids=new Set(this.library.entries().map(e=>e.id));for(const entry of this.catalog)if(ids.has(entry.id)&&entry.manifest_url){try{await this.install(entry.id);}catch{/* Installed release remains playable; next hub entry retries. */}}})().finally(()=>this.checking=null);return this.checking;
 }
}
module.exports={GameInstaller,validateRelease,extract,download,MAX_BYTES};
