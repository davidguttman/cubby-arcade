/* Pure host boundaries, testable without Electron. Developer packages are trusted. */
const fs=require('node:fs');
const path=require('node:path');
const idPattern=/^[a-z0-9][a-z0-9-]{0,79}$/;
// One portable namespace for installed files and protocol paths. NTFS aliases
// (devices, alternate streams, trailing dots/spaces) must never bypass inventory.
function safePackagePath(name){
  if(typeof name!=='string'||!name||/[\\\x00-\x1f\x7f<>:"|?*]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)))throw Error('Invalid package path');
  return name;
}
function validatePackagePaths(names){
  const paths=new Map();
  for(const name of names){
    safePackagePath(name);const parts=name.split('/');
    for(let i=1;i<=parts.length;i++){
      // Conservatively fold both ways: NTFS aliases include final sigma and
      // dotless I, which a lowercase-only comparison would miss.
      const spelling=parts.slice(0,i).join('/'),key=spelling.toUpperCase().toLowerCase(),file=i===parts.length,previous=paths.get(key);
      if(previous&&(previous.spelling!==spelling||previous.file||file))throw Error('Conflicting package paths');
      paths.set(key,{spelling,file});
    }
  }
}
// Use the same decoded identity for disk lookup, navigation and native authority.
function assetName(raw){
  if(decodeURIComponent(raw).split(/[/?#]/).includes('..'))throw Error('Invalid asset path');
  const url=new URL(raw);
  if(url.protocol!=='hub:'||url.hostname!=='app'||url.username||url.password||url.port)throw Error('Invalid hub origin');
  const name=decodeURIComponent(url.pathname);
  // Encoded separators, repeated separators and nested escapes are ambiguous to
  // URL resolution versus filesystem lookup; do not admit aliases for them.
  if(/%2f|%5c/i.test(url.pathname)||/%[a-f0-9]{2}/i.test(name)||name.includes('//')||name.includes('\0')||name.includes('\\')||name.split('/').includes('..'))throw Error('Invalid asset path');
  if(name!=='/')safePackagePath(name.slice(1));
  return name;
}
function assetPath(raw,root){
  const name=assetName(raw);
  const result=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!result.startsWith(path.resolve(root)+path.sep))throw Error('Asset outside export');
  return result;
}
function gameScope(raw){
  const match=/^\/games\/([a-z0-9][a-z0-9-]{0,79})\//.exec(assetName(raw));
  if(!match)throw Error('Game frame required');return match[1];
}
// Native system actions belong to the trusted top-level launcher, never games.
function requireHubFrame(event){
  if(event.senderFrame!==event.sender.mainFrame)throw Error('Main hub frame required');
  if(!['/','/index.html'].includes(assetName(event.senderFrame.url)))throw Error('Hub page required');
}
class SaveStore{
  constructor(root){this.root=root;fs.mkdirSync(root,{recursive:true,mode:0o700});}
  file(game,key){
    if(!idPattern.test(game)||!(/^[a-zA-Z0-9_-]{1,80}$/).test(key))throw Error('Invalid save scope');
    return path.join(this.root,game,key+'.json');
  }
  get(game,key){const file=this.file(game,key);try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  set(game,key,value){
    const file=this.file(game,key),body=JSON.stringify(value);
    if(body===undefined||Buffer.byteLength(body)>1024*1024)throw Error('Invalid save size');
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    const temporary=file+'.tmp';try{fs.writeFileSync(temporary,body,{mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
  }
  remove(game,key){fs.rmSync(this.file(game,key),{force:true});}
}
class GameLibrary{
  constructor(site,games){this.site=site;this.games=games;}
  managed(){return fs.existsSync(this.games);}
  release(id){
    if(!idPattern.test(id))throw Error('Invalid game id');
    safePackagePath(id);
    const releases=fs.realpathSync(path.join(this.games,id,'releases'));
    if(!releases.startsWith(fs.realpathSync(this.games)+path.sep))throw Error('Release outside games');
    let selected,selectedVersion;
    const selector=path.join(this.games,id,'current.json');
    try{
      const stat=fs.lstatSync(selector);
      if(!stat.isFile()||stat.size>1024)throw Error('Invalid release selector');
      const pointer=JSON.parse(fs.readFileSync(selector,'utf8'));
      if(!pointer||Array.isArray(pointer)||typeof pointer.version!=='string'||!(/^[a-z0-9][a-z0-9.-]{0,79}$/).test(pointer.version)||pointer.version.includes('..'))throw Error('Invalid release selector');
      safePackagePath(pointer.version);selectedVersion=pointer.version;selected=path.join(releases,pointer.version);
    }catch(error){
      // Only an absent new selector may use the old Linux symlink. Corruption
      // must fail closed, not silently launch an obsolete legacy release.
      if(error.code!=='ENOENT')throw error;
      selected=path.join(this.games,id,'current');
    }
    const directory=fs.realpathSync(selected);
    if(path.dirname(directory)!==releases)throw Error('Invalid release selector');
    const manifestPath=path.join(directory,'manifest.json');
    if(fs.statSync(manifestPath).size>256*1024)throw Error('Manifest too large');
    const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    if(m.id!==id||m.schema_version!==1||m.runtime!=='web'||typeof m.version!=='string'||!(/^[a-z0-9][a-z0-9.-]{0,79}$/).test(m.version)||m.version.includes('..')||!m.files||Array.isArray(m.files)||!Object.keys(m.files).length||Object.keys(m.files).length>1000)throw Error('Invalid manifest');
    safePackagePath(m.version);
    if(selectedVersion!==undefined&&m.version!==selectedVersion)throw Error('Release selector version mismatch');
    if(path.basename(directory)!==m.version)throw Error('Release selector version mismatch');
    validatePackagePaths(Object.keys(m.files));
    for(const [name,hash] of Object.entries(m.files)){
      if(name.startsWith('/')||name.includes('\\')||name.includes('\0')||name.split('/').some(p=>!p||p==='.'||p==='..')||!(/^[a-f0-9]{64}$/).test(hash))throw Error('Invalid inventory');
    }
    for(const name of ['entrypoint','artwork','attract'])if((name!=='attract'||m[name]!==undefined)&&!Object.hasOwn(m.files,m[name]))throw Error('Missing game asset');
    return {directory,manifest:m};
  }
  entries(){
    if(!this.managed())return [];
    const result=[];
    for(const id of fs.readdirSync(this.games).sort()){
      try{
        const {manifest:m}=this.release(id),base='/games/'+id+'/';
        result.push({id:m.id,version:m.version,runtime:m.runtime,entrypoint:base+m.entrypoint,artwork:base+m.artwork,...(m.attract?{attract:base+m.attract}:{})});
      }catch{/* Incomplete staging, removed or invalid packages are not discoverable. */}
    }
    return result;
  }
  file(raw){
    const bundled=assetPath(raw,this.site),name=assetName(raw);
    if(!name.startsWith('/games/'))return bundled;
    const match=/^\/games\/([a-z0-9][a-z0-9-]{0,79})\/(.+)$/.exec(name);
    if(!match)throw Error('Invalid game path');
    const {directory,manifest}=this.release(match[1]);
    if(!Object.hasOwn(manifest.files,match[2]))throw Error('Asset is not in inventory');
    const file=fs.realpathSync(path.join(directory,match[2]));
    if(!file.startsWith(directory+path.sep))throw Error('Asset outside release');
    return file;
  }
}
module.exports={assetName,assetPath,gameScope,requireHubFrame,SaveStore,GameLibrary,safePackagePath,validatePackagePaths};
