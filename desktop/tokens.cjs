/* Local family-test budget. A completed document launch costs one; time does not. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {assetName}=require('./host.cjs');
class TokenAccount{
 constructor(file){this.file=file;this.valid=false;try{
  if(!fs.existsSync(file)){fs.mkdirSync(path.dirname(file),{recursive:true});this.write(10);}
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data.schema_version!==1||!Number.isSafeInteger(data.balance)||data.balance<0||data.balance>10000)throw Error('Invalid account');
  this.balance=data.balance;this.valid=true;
 }catch{/* Preserve broken data, fail closed; never mint replacement tokens. */}}
 status(){return {available:this.valid,balance:this.valid?this.balance:null};}
 write(balance){const temp=this.file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';try{fs.writeFileSync(temp,JSON.stringify({schema_version:1,balance})+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,this.file);}finally{fs.rmSync(temp,{force:true});}this.balance=balance;}
 require(){if(!this.valid)throw Error('Account unavailable');}
 debit(){this.require();if(this.balance<1)throw Error('No tokens');this.write(this.balance-1);}
 refill(){this.require();if(this.balance>9990)throw Error('Token limit');this.write(this.balance+10);return this.status();}
}
class GameLauncher{
 constructor(account,library,options){this.account=account;this.library=library;this.navigate=options.navigate;this.onChange=options.onChange||(()=>{});this.session=null;this.pending=null;this.error=false;}
 status(){return {...this.account.status(),launchFailed:this.error};}
 inSession(raw){try{return this.session!==null&&assetName(raw).startsWith('/games/'+this.session+'/');}catch{return false;}}
 home(){this.session=null;}
 launch(id){
  if(this.pending)return this.pending;
  let entry;try{
   this.account.require();if(this.account.balance<1)throw Error('No tokens');
   entry=this.library.entries().find(e=>e.id===id);if(!entry)throw Error('Game not installed');
   const file=this.library.file('hub://app'+entry.entrypoint);if(!fs.statSync(file).isFile())throw Error('Missing entrypoint');
  }catch(e){this.error=this.account.valid&&this.account.balance>0;this.onChange(this.status());return Promise.reject(e);}
  this.error=false;this.session=id;
  this.pending=(async()=>{try{await this.navigate('hub://app'+entry.entrypoint);this.account.debit();return this.status();}
   catch(e){this.session=null;this.error=true;throw e;}
   finally{this.pending=null;this.onChange(this.status());}})();return this.pending;
 }
}
module.exports={TokenAccount,GameLauncher};
