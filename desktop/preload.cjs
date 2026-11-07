const {contextBridge,ipcRenderer}=require('electron');
function save(operation,game,key,value){
  const result=ipcRenderer.sendSync('hub:save',{operation,game,key,value});
  if(result.error)throw Error(result.error);return result.value;
}
contextBridge.exposeInMainWorld('HandheldPlatformOptions',{
  kind:'desktop',bridge:{
    account:()=>ipcRenderer.invoke('hub:account'),
    refillTokens:()=>ipcRenderer.invoke('hub:refill'),
    launch:id=>ipcRenderer.invoke('hub:launch',id),
    onAccountState:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('hub:account-state',listener);return ()=>ipcRenderer.removeListener('hub:account-state',listener);},
    savedGames:profile=>ipcRenderer.invoke('hub:saved-games',profile),
    resetGameSaves:(id,profile)=>ipcRenderer.invoke('hub:reset-game-saves',id,profile),
    useProfile:profile=>ipcRenderer.invoke('hub:profile',profile),
    removeProfile:profile=>ipcRenderer.invoke('hub:remove-profile',profile),
    library:()=>ipcRenderer.invoke('hub:library'),
    install:id=>ipcRenderer.invoke('hub:install',id),
    uninstall:id=>ipcRenderer.invoke('hub:uninstall',id),
    installStatus:()=>ipcRenderer.invoke('hub:install-status'),
    onInstallState:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('hub:install-state',listener);return ()=>ipcRenderer.removeListener('hub:install-state',listener);},
    quit:()=>ipcRenderer.invoke('hub:quit'),saves(game){return {
    get:key=>save('get',game,key),set:(key,value)=>save('set',game,key,value),remove:key=>save('remove',game,key)
  };}}
});
