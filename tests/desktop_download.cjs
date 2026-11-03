const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const windows='https://github.com/davidguttman/cubby-arcade/releases/latest/download/CubbyArcade-win32-x64.zip';
const linux='https://github.com/davidguttman/cubby-arcade/releases/latest/download/CubbyArcade-linux-x64.tar.gz';
test('landing download defaults to Windows without JavaScript',()=>{
 const html=fs.readFileSync(path.join(root,'website/index.html'),'utf8');
 assert.match(html,/<a[^>]*data-desktop-download[^>]*>Get the Windows app ↓<\/a>/);
 assert(html.includes('href="'+windows+'"'));
 assert.match(html,/<script[^>]*src="\/site\/desktop-download.js"[^>]*defer/);
});
test('desktop Linux changes both label and target; other clients retain Windows',()=>{
 const script=fs.readFileSync(path.join(root,'website/desktop-download.js'),'utf8');
 for(const [userAgent,isLinux] of [
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',true],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)',false],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',false],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',false],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',false],
  ['',false],[undefined,false]
 ]){
  const link={href:windows,textContent:'Get the Windows app ↓'};
  const context={document:{querySelector:()=>link}};
  if(userAgent!==undefined)context.navigator={userAgent};
  vm.runInNewContext(script,context);
  assert.equal(link.textContent,isLinux?'Get the Linux app ↓':'Get the Windows app ↓',userAgent);
  assert.equal(link.href,isLinux?linux:windows,userAgent);
 }
});
