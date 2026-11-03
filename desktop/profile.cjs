/* Keep existing desktop saves, installs, preferences and test budgets across branding. */
const fs=require('node:fs');
const path=require('node:path');
function userDataPath({appData,temp,smoke,override},exists=fs.existsSync){
  if(override)return path.resolve(override);
  if(smoke)return path.join(temp,'cubby-arcade-smoke-profile');
  const canonical=path.join(appData,'CubbyArcade');
  if(exists(canonical))return canonical;
  // Historical app.asar metadata used the package name even in packaged builds.
  // Recognize the old product-name profile too, but never discard either one.
  for(const name of ['handheld-os-desktop','HandheldHub']){
    const legacy=path.join(appData,name);
    if(exists(legacy))return legacy;
  }
  return canonical;
}
module.exports={userDataPath};
