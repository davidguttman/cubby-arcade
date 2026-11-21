/** A failed or stalled essential resource must not enable an unstyled host. */
export function watchResource(element, loaded, win, timeout = 15000) {
  let finish;
  const ready = new Promise(resolve => {
    let settled = false;
    const onLoad = () => finish(true), onError = () => finish(false);
    const timer = win.setTimeout(onError, timeout);
    finish = result => {
      if (settled) return;
      settled = true;
      win.clearTimeout(timer);
      element.removeEventListener('load', onLoad);
      element.removeEventListener('error', onError);
      resolve(result);
    };
    element.addEventListener('load', onLoad);
    element.addEventListener('error', onError);
    if (loaded()) finish(true);
  });
  return { ready, destroy: () => finish(false) };
}
