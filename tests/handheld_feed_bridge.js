// Called by Python's real HTTP integration test. No server or fake host here.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createPlatform}=require('../runtime/core/platform.js'),{sweepGameUpdates}=require('../runtime/core/hub.js');
const {DEFAULT_URL}=require('../runtime/core/game-feeds.js');
const [origin,token,mode]=process.argv.slice(2),custom='https://other.test/catalog';
const win={CubbyDeviceToken:token,addEventListener(){},fetch:(url,options={})=>fetch(origin+url,{...options,headers:{...options.headers,Origin:origin,Referer:origin+'/'}})};
vm.runInNewContext(fs.readFileSync('rocknix/bridge.js','utf8'),{window:win,setTimeout,setInterval,clearInterval,JSON,Error,Set,Promise});
const config=feeds=>({schema:1,feeds:feeds.map(([url,enabled=true])=>({url,name:url,enabled}))});
(async()=>{
 const p=createPlatform(win.HandheldPlatformOptions);
 if(mode==='install'){await p.setFeedConfig(config([[custom],[DEFAULT_URL]]));assert.equal((await p.catalog())[0].title,'Other');await p.install('demo');}
 if(mode==='reorder'){await p.setFeedConfig(config([[DEFAULT_URL],[custom]]));assert.equal((await p.catalog())[0].title,'First');await assert.rejects(p.install('demo'),/source/);await sweepGameUpdates(p);}
 if(mode==='disable'){await p.setFeedConfig(config([[DEFAULT_URL],[custom,false]]));await sweepGameUpdates(p);}
 if(mode==='remove'){await p.setFeedConfig(config([[DEFAULT_URL]]));await sweepGameUpdates(p);}
 if(mode==='offline'){await p.setFeedConfig(config([[custom],[DEFAULT_URL]]));assert.equal((await p.catalog())[0].title,'Other');}
 if(mode==='replace'){await p.uninstall('demo');await p.setFeedConfig(config([[DEFAULT_URL]]));await p.catalog();await p.install('demo');}
 console.log(JSON.stringify(await p.library()));
})().catch(error=>{console.error(error);process.exitCode=1;});
