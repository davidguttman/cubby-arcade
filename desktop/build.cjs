/* Assemble only the desktop host and validated export, never repository state. */
const {packager}=require('@electron/packager');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
(async()=>{
  const platform=process.argv[2]||'linux';
  if(!['linux','win32'].includes(platform)||process.argv.length>3)throw Error('Usage: node desktop/build.cjs [linux|win32]');
  const root=path.join(__dirname,'..');
  const metadata=require('../package.json');
  const stage=await fs.mkdtemp(path.join(os.tmpdir(),'cubby-arcade-desktop-'));
  try{
    await fs.mkdir(path.join(stage,'desktop'));
    for(const name of ['main.cjs','profile.cjs','preload.cjs','host.cjs','hub-smoke.cjs','cloud.cjs','feeds.cjs','installer.cjs','install-smoke.cjs','tokens.cjs','token-smoke.cjs','uninstall-smoke.cjs','players-smoke.cjs'])await fs.copyFile(path.join(__dirname,name),path.join(stage,'desktop',name));
    // The host maps players to save directories with the hub's own player rules.
    await fs.mkdir(path.join(stage,'runtime','core'),{recursive:true});
    await fs.copyFile(path.join(root,'runtime','core','profiles.js'),path.join(stage,'runtime','core','profiles.js'));
    await fs.copyFile(path.join(root,'runtime','core','game-feeds.js'),path.join(stage,'runtime','core','game-feeds.js'));
    // Copy the exact production dependency closure, not dev tools or arbitrary repo files.
    const copied=new Set();
    async function dependency(name,from=root){
      const manifest=require.resolve(name+'/package.json',{paths:[from]});
      const source=path.dirname(manifest),meta=JSON.parse(await fs.readFile(manifest,'utf8'));
      if(copied.has(name))return;copied.add(name);
      await fs.cp(source,path.join(stage,'node_modules',name),{recursive:true});
      for(const child of Object.keys(meta.dependencies||{}))await dependency(child,source);
    }
    for(const name of Object.keys(metadata.dependencies||{}))await dependency(name);
    await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({name:metadata.name,version:metadata.version,main:metadata.main}));
    const outputs=await packager({dir:stage,name:'CubbyArcade',platform,arch:'x64',
      electronVersion:metadata.devDependencies.electron,out:path.join(root,'dist'),overwrite:true,
      asar:true,prune:false,extraResource:[path.join(root,'.cache/web')],
      ...(platform==='win32'?{win32metadata:{CompanyName:'David Guttman',FileDescription:'Cubby Arcade',ProductName:'Cubby Arcade'}}:{})});
    console.log(outputs);
    execFileSync('uv',['run','python',path.join(__dirname,'archive.py'),outputs[0],platform==='win32'?'zip':'tar.gz'],{cwd:root,stdio:'inherit'});
  }finally{await fs.rm(stage,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
