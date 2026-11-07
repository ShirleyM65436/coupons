// services/install.js - "Install app" prompt handling (Chrome/Android beforeinstallprompt).

/**
 * Listen for the browser's install prompt (beforeinstallprompt).
 * @param {{ onAvailable: (promptInstall: () => Promise<'accepted'|'dismissed'>) => void, onInstalled?: () => void }} handlers
 *   onAvailable is called when the app can be installed; calling promptInstall() shows the browser dialog.
 *   onInstalled is called after the app was installed (appinstalled event).
 */
export function initInstallPrompt({ onAvailable, onInstalled } = {}) {
  const isStandalone = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true; // iOS Safari

  let deferred = null; // the stashed beforeinstallprompt event

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // stop the mini-infobar, we show our own button
    if (isStandalone()) return; // already installed and running as an app
    deferred = event;
    onAvailable?.(async function promptInstall() {
      const ev = deferred;
      if (!ev) return 'dismissed';
      deferred = null; // the event can only be used once
      await ev.prompt();
      const choice = await ev.userChoice;
      return choice.outcome;
    });
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    onInstalled?.();
  });
}
