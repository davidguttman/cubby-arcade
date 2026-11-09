/* Raw feed storage/network IO. Merge, source pinning and refresh policy live in core. */
const fs=require('node:fs/promises'),path=require('node:path');
const Feeds=require('../runtime/core/game-feeds.js');
const {download}=require('./installer.cjs');
const MAX_STATE=20*1024*1024;
class FeedIO{
 constructor(file,{fetch=globalThis.fetch}={}){this.file=file;this.fetch=fetch;this.fetched=new Map();}
 async read(){
  let bytes;try{const stat=await fs.stat(this.file);if(stat.size>MAX_STATE)throw Error('Feed state too large');bytes=await fs.readFile(this.file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const value=JSON.parse(bytes);
  for(const [url,entries] of Object.entries(value.cache||{}))try{this.fetched.set(Feeds.feedURL(url),Feeds.validateEntries(entries));}catch{}
  return value;
 }
 async write(value){
  const text=JSON.stringify(value);if(Buffer.byteLength(text)>MAX_STATE)throw Error('Feed state too large');
  await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(this.file+'.tmp',text,{mode:0o600});await fs.rename(this.file+'.tmp',this.file);
 }
 async catalog(url){
  url=Feeds.feedURL(url);
  const bytes=await download(this.fetch,url,1024*1024,AbortSignal.timeout(20000));
  const entries=Feeds.validateEntries(JSON.parse(bytes));this.fetched.set(url,entries);return entries;
 }
 offer(id,value){
  Feeds.validateEntries([value]);const source=Feeds.sourceOf(value);
  if(value.id!==id||!(this.fetched.get(source.feed_url)||[]).some(entry=>entry.id===id&&entry.manifest_url===source.manifest_url))throw Error('Game source not offered');
  return structuredClone(value);
 }
}
module.exports={FeedIO};
