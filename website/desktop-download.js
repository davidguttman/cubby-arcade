/* Keep the HTML's Windows default unless this is a desktop Linux browser. */
(()=>{
  const userAgent=globalThis.navigator?.userAgent||'';
  if(!/Linux/i.test(userAgent)||/Android/i.test(userAgent))return;
  const link=document.querySelector('[data-desktop-download]');
  if(!link)return;
  link.href='https://github.com/davidguttman/cubby-arcade/releases/latest/download/CubbyArcade-linux-x64.tar.gz';
  link.textContent='Download for Linux ↓';
})();
