/* Assemble only the desktop host and validated export, never repository state. */
const {packager}=require('@electron/packager');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
(async()=>{
  const root=path.join(__dirname,'..');
  const metadata=require('../package.json');
  const stage=await fs.mkdtemp(path.join(os.tmpdir(),'handheld-desktop-'));
  try{
    await fs.mkdir(path.join(stage,'desktop'));
    for(const name of ['main.cjs','preload.cjs','host.cjs'])await fs.copyFile(path.join(__dirname,name),path.join(stage,'desktop',name));
    await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({name:metadata.name,version:metadata.version,main:metadata.main}));
    console.log(await packager({dir:stage,name:'HandheldHub',platform:'linux',arch:'x64',
      electronVersion:metadata.devDependencies.electron,out:path.join(root,'dist'),overwrite:true,
      asar:true,prune:false,extraResource:[path.join(root,'.cache/web')]}));
  }finally{await fs.rm(stage,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
