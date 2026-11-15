/* Native game navigation and session ownership; launches have no budget. */
const fs=require('node:fs');
const {assetName}=require('./host.cjs');
class GameLauncher{
 constructor(library,options){this.library=library;this.navigate=options.navigate;this.session=null;this.pending=null;}
 inSession(raw){try{return this.session!==null&&assetName(raw).startsWith('/games/'+this.session+'/');}catch{return false;}}
 home(){this.session=null;}
 launch(id){
  if(this.pending)return this.pending;
  let entry;try{
   entry=this.library.entries().find(e=>e.id===id);if(!entry)throw Error('Game not installed');
   const file=this.library.file('hub://app'+entry.entrypoint);if(!fs.statSync(file).isFile())throw Error('Missing entrypoint');
  }catch(e){return Promise.reject(e);}
  this.session=id;
  this.pending=Promise.resolve().then(()=>this.navigate('hub://app'+entry.entrypoint))
   .catch(error=>{this.session=null;throw error;})
   .finally(()=>{this.pending=null;});
  return this.pending;
 }
}
module.exports={GameLauncher};
