/* Store feed policy shared by every host. Hosts supply JSON storage and bounded
 * catalog downloads; this module never touches game files, saves or the network.
 * Shared refresh IO has no caller-owned signal: fetchCatalog must enforce its
 * own deadline. A catalog caller's signal only cancels that caller's wait.
 * Hosts retain the exact catalog()/updateOffer() object across install and pass
 * it to pin() before install IO exposes bytes; IPC-returned copies are not pins.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.HandheldGameFeeds=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DEFAULT_URL='https://cubby.david.app/catalog',BETA_URL='https://cubby.david.app/beta/catalog',MAX_FEEDS=16;
  const FIRST='p_first',profileId=value=>{if(typeof value!=='string'||!/^p_[a-z0-9]{1,24}$/.test(value))throw Error('Invalid player');return value;};
  const ID=/^[a-z0-9][a-z0-9-]{0,79}$/;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const gameId=value=>typeof value==='string'&&ID.test(value);
  function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
  function feedURL(value){
    if(typeof value!=='string'||value.length>2048||!/^https:\/\/[^/]/i.test(value)||/[\\\x00-\x20\x7f#]/.test(value)||/%(?![0-9a-f]{2})|%(?:0[0-9a-f]|1[0-9a-f]|20|7f|5c)/i.test(value))throw Error('A feed needs an absolute HTTPS URL');
    const url=new URL(value);
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)throw Error('A feed needs an absolute HTTPS URL');
    return url.href;
  }
  function defaultConfig(){return {schema:1,feeds:[{url:DEFAULT_URL,name:'Cubby Arcade',enabled:true},{url:BETA_URL,name:'Cubby Beta',enabled:false}]};}
  function validateConfig(value){
    if(!object(value)||value.schema!==1||!Array.isArray(value.feeds)||value.feeds.length>MAX_FEEDS)throw Error('Invalid feed configuration');
    const seen=new Set();
    return {schema:1,feeds:value.feeds.map(feed=>{
      if(!object(feed)||typeof feed.name!=='string'||!feed.name.trim()||feed.name.length>120||/[\x00-\x1f\x7f]/.test(feed.name)||typeof feed.enabled!=='boolean')throw Error('Invalid feed settings');
      const url=feedURL(feed.url);if(seen.has(url))throw Error('Feed already added');seen.add(url);
      return {url,name:feed.name.trim(),enabled:feed.enabled};
    })};
  }
  function validateEntries(entries){
    if(!Array.isArray(entries)||entries.length>1000)throw Error('Invalid Store catalog');
    const seen=new Set();
    for(const entry of entries){
      if(!object(entry)||!gameId(entry.id)||seen.has(entry.id)||typeof entry.title!=='string'||!entry.title||entry.title.length>120)throw Error('Invalid Store entry');
      seen.add(entry.id);
      for(const field of ['manifest_url','artwork',...(entry.attract!==undefined?['attract']:[])])feedURL(entry[field]);
      if(entry.screenshots!==undefined){if(!Array.isArray(entry.screenshots)||entry.screenshots.length>12)throw Error('Invalid Store screenshots');for(const url of entry.screenshots)feedURL(url);}
    }
    return copy(entries);
  }
  function source(value){
    if(!object(value))throw Error('Invalid game source');
    return {feed_url:feedURL(value.feed_url),manifest_url:feedURL(value.manifest_url)};
  }
  function sourced(entry,url){return {...copy(entry),_source:{feed_url:url,manifest_url:feedURL(entry.manifest_url)}};}
  function sourceOf(offer){
    const result=source(offer?._source);
    if(result.manifest_url!==feedURL(offer.manifest_url))throw Error('Game source does not match offer');
    return result;
  }
  function mergeCatalog(config,cache){
    const seen=new Set(),result=[];
    for(const feed of validateConfig(config).feeds){
      if(!feed.enabled)continue;
      for(const entry of cache[feed.url]||[]){if(seen.has(entry.id))continue;seen.add(entry.id);result.push(sourced(entry,feed.url));}
    }
    return result;
  }
  function updateOffer(id,pin,config,cache){
    if(!gameId(id)||!pin)return null;
    const selected=source(pin),enabled=validateConfig(config).feeds.some(feed=>feed.enabled&&feed.url===selected.feed_url);
    if(!enabled)return null;
    const entry=(cache[selected.feed_url]||[]).find(entry=>entry.id===id&&feedURL(entry.manifest_url)===selected.manifest_url);
    return entry?sourced(entry,selected.feed_url):null;
  }
  // Old installs only ever came from the built-in catalog. Do not let a newly
  // added custom feed claim one just because it has the same short game ID.
  function legacySource(id,cache){
    const entry=(cache[DEFAULT_URL]||[]).find(entry=>entry.id===id);
    return entry?{feed_url:DEFAULT_URL,manifest_url:feedURL(entry.manifest_url)}:null;
  }
  function waitFor(pending,signal){
    if(!signal)return pending;
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const clear=()=>signal.removeEventListener('abort',aborted);
      const aborted=()=>{clear();reject(signal.reason);};
      signal.addEventListener('abort',aborted,{once:true});
      pending.then(value=>{clear();resolve(value);},error=>{clear();reject(error);});
    });
  }
  function createManager(options){
    if(typeof options?.read!=='function'||typeof options.write!=='function'||typeof options.fetchCatalog!=='function')throw Error('Feed storage and fetch IO required');
    let state,loading,queue=Promise.resolve(),needsPersist=false;
    const refreshing=new Map();
    const selected=(value,profile)=>value.profiles[profileId(profile)]||defaultConfig();
    // Weak keys keep provenance alive exactly as long as a host retains an
    // issued offer, without retaining an ever-growing history of old catalogs.
    const issued=new WeakMap(),outcomes=new Map();
    function issue(offer){if(offer)issued.set(offer,{id:offer.id,...sourceOf(offer)});return offer;}
    const validate=entries=>validateEntries(options.validateCatalog?options.validateCatalog(entries):entries);
    async function load(){
      if(!loading)loading=(async()=>{
        const saved=await options.read();
        if(saved===undefined||saved===null){state={schema:1,config:defaultConfig(),profiles:{},cache:{},sources:{}};return;}
        if(!object(saved)||saved.schema!==1||!object(saved.cache)||!object(saved.sources))throw Error('Invalid saved feeds');
        const cache={},sources={};
        for(const [url,entries] of Object.entries(saved.cache)){
          // A bad cached response is not configuration and can be fetched again.
          try{cache[feedURL(url)]=validate(entries);}catch{}
        }
        for(const [id,pin] of Object.entries(saved.sources)){
          if(!gameId(id))throw Error('Invalid saved game source');
          sources[id]=source(pin);
        }
        const config=validateConfig(saved.config),profiles={};
        if(saved.profiles!==undefined){
          if(!object(saved.profiles))throw Error('Invalid player feeds');
          for(const [id,config] of Object.entries(saved.profiles))profiles[profileId(id)]=validateConfig(config);
        }else{
          // Snapshot everyone who existed before profile-scoped feeds. Later
          // players start with defaults, never another player's beta choices.
          const migrated=copy(config);
          if(migrated.feeds.length&&migrated.feeds.length<MAX_FEEDS&&!migrated.feeds.some(feed=>feed.url===BETA_URL))migrated.feeds.push({url:BETA_URL,name:'Cubby Beta',enabled:false});
          for(const id of options.profileIds?.()||[FIRST])profiles[profileId(id)]=copy(migrated);
        }
        state={schema:1,config,profiles,cache,sources};
        needsPersist=saved.profiles===undefined;
      })();
      await loading;
    }
    function change(fn){
      const job=queue.then(async()=>{
        await load();const next=copy(state),result=fn(next);
        // Publish in memory only after durable write succeeds.
        await options.write(copy(next));state=next;needsPersist=false;return result;
      });
      queue=job.catch(()=>{});return job;
    }
    const manager={
      async config(profile=FIRST){await load();await queue;if(needsPersist)await change(()=>{});return copy(selected(state,profile));},
      async setConfig(config,profile=FIRST){profileId(profile);const checked=validateConfig(config);await change(next=>{next.profiles[profile]=checked;if(profile===FIRST)next.config=checked;});return copy(checked);},
      async status(profile=FIRST){
        await load();await queue;
        return Object.fromEntries(selected(state,profile).feeds.map(feed=>{
          const count=(state.cache[feed.url]||[]).length,outcome=outcomes.get(feed.url);
          const status={state:!feed.enabled?'disabled':outcome?.ok?'loaded':Object.hasOwn(state.cache,feed.url)?'cached':outcome?'unavailable':'unchecked',count};
          if(feed.enabled&&outcome?.error)status.error=outcome.error;
          return [feed.url,status];
        }));
      },
      async catalog({signal}={},profile=FIRST){
        profileId(profile);
        signal?.throwIfAborted();
        if(!refreshing.has(profile)){
          const pending=(async()=>{
            await load();await queue;
            const feeds=selected(state,profile).feeds.filter(feed=>feed.enabled);
            const results=await Promise.all(feeds.map(async feed=>{
              try{return {url:feed.url,entries:validate(await options.fetchCatalog(feed.url,{}))};}
              catch(error){return {url:feed.url,error:typeof error?.message==='string'?error.message.slice(0,200):'Catalog request failed'};}
            }));
            const valid=results.filter(result=>result.entries!==undefined);
            if(valid.length)await change(next=>{for(const result of valid)next.cache[result.url]=result.entries;});
            for(const result of results)outcomes.set(result.url,result.entries!==undefined?{ok:true}:{error:result.error});
          })();
          refreshing.set(profile,pending);
          // Only shared work completion releases the refresh, never a caller's
          // cancellation. Handle failures even if every waiting caller left.
          const clear=()=>{if(refreshing.get(profile)===pending)refreshing.delete(profile);};
          pending.then(clear,clear);
        }
        await waitFor(refreshing.get(profile),signal);await waitFor(queue,signal);signal?.throwIfAborted();
        return mergeCatalog(selected(state,profile),state.cache).map(issue);
      },
      async pin(id,offer){
        if(!gameId(id)||offer?.id!==id)throw Error('Invalid game source identity');
        const pin=sourceOf(offer);
        const offered=issued.get(offer);
        if(!offered||offered.id!==id||offered.feed_url!==pin.feed_url||offered.manifest_url!==pin.manifest_url)throw Error('Game source was not offered');
        await change(next=>{
          const previous=Object.hasOwn(next.sources,id)?next.sources[id]:null;
          if(previous&&(previous.feed_url!==pin.feed_url||previous.manifest_url!==pin.manifest_url))throw Error('Game already belongs to another source');
          // Catalog changes/removal during install cannot erase the provenance
          // reserved for its bytes. The issued record was checked above.
          next.sources[id]=pin;
        });
      },
      async forget(id){if(!gameId(id))throw Error('Invalid game id');await change(next=>{delete next.sources[id];});},
      async migrateInstalled(ids){
        if(!Array.isArray(ids)||ids.some(id=>!gameId(id)))throw Error('Invalid installed game ids');
        await load();await queue;
        const missing=ids.filter(id=>!Object.hasOwn(state.sources,id)&&legacySource(id,state.cache));
        if(missing.length)await change(next=>{for(const id of missing)if(!Object.hasOwn(next.sources,id)){
          // A queued refresh may have removed the legacy offer since inspection.
          const pin=legacySource(id,next.cache);if(pin)next.sources[id]=pin;
        }});
      },
      async updateOffer(id,profile=FIRST){await load();await queue;return issue(updateOffer(id,Object.hasOwn(state.sources,id)?state.sources[id]:null,selected(state,profile),state.cache));},
      async visible(ids,profile=FIRST){await load();await queue;const enabled=new Set(selected(state,profile).feeds.filter(feed=>feed.enabled).map(feed=>feed.url));return ids.filter(id=>!Object.hasOwn(state.sources,id)||enabled.has(state.sources[id].feed_url));},
      async removeProfile(profile){profileId(profile);await change(next=>{delete next.profiles[profile];if(profile===FIRST)next.config=defaultConfig();});},
      async source(id){await load();await queue;return Object.hasOwn(state.sources,id)?copy(state.sources[id]):null;}
    };
    return manager;
  }
  return {DEFAULT_URL,BETA_URL,MAX_FEEDS,feedURL,defaultConfig,validateConfig,validateEntries,sourceOf,mergeCatalog,updateOffer,legacySource,createManager};
});
