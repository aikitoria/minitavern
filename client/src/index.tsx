/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App.tsx';
import { configureWs, startWs, stopWs } from './state/ws.ts';
import { handleServerEvent, loadAll, setState } from './state/store.ts';
import { checkAuthentication, configureAuthLifecycle, requireLogin } from './state/auth.ts';
import { setAuthenticationRequiredHandler } from './state/api.ts';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/ibm-plex-sans/wght-italic.css';
import './styles/app.css';
import 'highlight.js/styles/github-dark.css';

configureWs({
  onEvent: handleServerEvent,
  onOpen: () => void loadAll(),
  onStatus: (connected) => setState('connected', connected),
  onUnauthorized: () => void checkAuthentication(),
});
configureAuthLifecycle({ onUnlock: startWs, onLock: stopWs });
setAuthenticationRequiredHandler(requireLogin);

render(() => <App />, document.getElementById('root')!);
void checkAuthentication();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
