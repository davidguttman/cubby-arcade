/* Fetch one coherent launcher snapshot at startup. Games and user data stay local. */
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const DEFAULT_ORIGIN='https://cubby.david.app';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function shellPath(name){return name==='/index.html'||name==='/catalog'||/^\/runtime\/core\/[a-z0-9-]+\.(js|css)$/.test(name);}
function validate(raw){
 if(!raw||raw.schema_version!==1||raw.bridge_version!==1||!raw.files||Array.isArray(raw.files))throw Error('Unsupported hub manifest');
 const entries=Object.entries(raw.files);let total=0;
 if(entries.length<3||entries.length>64||!raw.files['/index.html']||!raw.files['/catalog']||!raw.files['/runtime/core/hub.js'])throw Error('Incomplete hub');
 for(const [name,entry] of entries){
  if(!shellPath(name)||!entry||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>2*1024*1024||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid hub asset');
  total+=entry.size;
 }
 if(total>8*1024*1024)throw Error('Hub too large');
 return raw;
}
function registryURL(value){
 if(typeof value!=='string')throw Error('Invalid registry URL');
 const url=new URL(value);if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)throw Error('HTTPS registry URL required');
}
function validateCatalog(data){
 const entries=JSON.parse(data);if(!Array.isArray(entries)||entries.length>1000)throw Error('Invalid catalog');
 const seen=new Set();
 for(const entry of entries){
  if(!entry||typeof entry.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.id)||seen.has(entry.id))throw Error('Invalid catalog identity');
  seen.add(entry.id);
  if(Object.hasOwn(entry,'manifest_url')){
   if(typeof entry.title!=='string'||!entry.title.length||entry.title.length>120)throw Error('Invalid registry title');
   for(const name of ['manifest_url','artwork',...(entry.attract!==undefined?['attract']:[])])registryURL(entry[name]);
   const screenshots=entry.screenshots??[];if(!Array.isArray(screenshots)||screenshots.length>12)throw Error('Invalid screenshots');
   screenshots.forEach(registryURL);
  }else{
   // Compatibility for older bundled hub catalogs; these are not install offers.
   for(const name of ['artwork','entrypoint',...(entry.attract?['attract']:[])]){
    const value=entry[name];if(typeof value!=='string'||!value.startsWith('/games/'+entry.id+'/')||value.includes('..')||value.includes('\\')||/[?#\x00]/.test(value))throw Error('Invalid catalog asset');
   }
  }
 }
 return entries;
}

class CloudHub{
 constructor(root,options={}){
  this.root=root;this.origin=options.origin||DEFAULT_ORIGIN;this.fetch=options.fetch||globalThis.fetch;this.source='bundle';this.directory=null;this.manifest=null;
  const url=new URL(this.origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('HTTPS hub origin required');
 }
 async download(name,limit,signal){
  const response=await this.fetch(new URL(name,this.origin),{redirect:'error',signal,cache:'no-store'});
  if(!response.ok)throw Error('Hub unavailable');
  const declared=Number(response.headers.get('content-length'));if(declared>limit)throw Error('Hub response too large');
  let size=0;const chunks=[];
  if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('Hub response too large');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks);
 }
 async load(directory){
  const manifest=validate(JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8')));
  for(const [name,entry] of Object.entries(manifest.files)){const data=await fs.readFile(path.join(directory,name.slice(1)));if(data.length!==entry.size||hash(data)!==entry.sha256)throw Error('Invalid cached hub');}
  validateCatalog(await fs.readFile(path.join(directory,'catalog'),'utf8'));
  this.directory=directory;this.manifest=manifest;
 }
 async refresh(){
  let stage;
  try{
   const signal=AbortSignal.timeout(5000);
   const manifest=validate(JSON.parse((await this.download('/hub-manifest.json',65536,signal)).toString('utf8')));
   await fs.mkdir(this.root,{recursive:true});stage=await fs.mkdtemp(path.join(this.root,'.stage-'));
   const downloads=await Promise.allSettled(Object.entries(manifest.files).map(async([name,entry])=>{
    // Public /index.html may be a landing page. Keep native cache keys stable,
    // but fetch the dedicated shell; old hosts can still serve the legacy URL.
    let data;
    if(name==='/index.html'){
     try{data=await this.download('/native/index.html',entry.size,signal);}catch{data=null;}
     if(!data||data.length!==entry.size||hash(data)!==entry.sha256)data=await this.download(name,entry.size,signal);
    }else data=await this.download(name,entry.size,signal);
    if(data.length!==entry.size||hash(data)!==entry.sha256)throw Error('Hub integrity mismatch');
    const file=path.join(stage,name.slice(1));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);
   }));
   const failed=downloads.find(r=>r.status==='rejected');if(failed)throw failed.reason;
   await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest));
   // Validate the complete replacement (including catalog) before touching cache.
   await this.load(stage);
   const version=hash(JSON.stringify(manifest)),destination=path.join(this.root,version);
   try{await fs.rename(stage,destination);stage=null;}catch(error){
    if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;
    try{await this.load(destination);}catch{
     // Only this invalid, content-addressed snapshot is replaced. Other versions
     // and the verified staged download remain untouched until activation.
     await fs.rm(destination,{recursive:true,force:true});
     await fs.rename(stage,destination);stage=null;
    }
   }
   await this.load(destination);
   const pointer=path.join(this.root,'current.tmp');await fs.writeFile(pointer,version);await fs.rename(pointer,path.join(this.root,'current'));
   this.source='cloud';
  }catch{
   try{const version=(await fs.readFile(path.join(this.root,'current'),'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(version))throw Error('Invalid cache pointer');await this.load(path.join(this.root,version));this.source='cache';}catch{this.directory=null;this.manifest=null;this.source='bundle';}
  }finally{if(stage)await fs.rm(stage,{recursive:true,force:true});}
 }
 async read(name){name=name==='/'?'/index.html':name;if(!this.directory||!shellPath(name)||!Object.hasOwn(this.manifest.files,name))return null;return fs.readFile(path.join(this.directory,name.slice(1)));}
}
module.exports={CloudHub,validate,validateCatalog,DEFAULT_ORIGIN};
