/* Assemble only the desktop host and validated export, never repository state. */
const {packager}=require('@electron/packager');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
(async()=>{
  const root=path.join(__dirname,'..');
  const metadata=require('../package.json');
  const stage=await fs.mkdtemp(path.join(os.tmpdir(),'cubby-arcade-desktop-'));
  try{
    await fs.mkdir(path.join(stage,'desktop'));
    for(const name of ['main.cjs','profile.cjs','preload.cjs','host.cjs','hub-smoke.cjs','cloud.cjs','installer.cjs','install-smoke.cjs'])await fs.copyFile(path.join(__dirname,name),path.join(stage,'desktop',name));
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
    console.log(await packager({dir:stage,name:'CubbyArcade',platform:'linux',arch:'x64',
      electronVersion:metadata.devDependencies.electron,out:path.join(root,'dist'),overwrite:true,
      asar:true,prune:false,extraResource:[path.join(root,'.cache/web')]}));
  }finally{await fs.rm(stage,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
