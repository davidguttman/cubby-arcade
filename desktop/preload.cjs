const {contextBridge,ipcRenderer}=require('electron');
function save(operation,game,key,value){
  const result=ipcRenderer.sendSync('hub:save',{operation,game,key,value});
  if(result.error)throw Error(result.error);return result.value;
}
contextBridge.exposeInMainWorld('HandheldPlatformOptions',{
  kind:'desktop',bridge:{quit:()=>ipcRenderer.invoke('hub:quit'),saves(game){return {
    get:key=>save('get',game,key),set:(key,value)=>save('set',game,key,value),remove:key=>save('remove',game,key)
  };}}
});
