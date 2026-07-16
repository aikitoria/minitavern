/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App.tsx';
import { configureWs, startWs } from './state/ws.ts';
import { handleServerEvent, loadAll, restoreFromHash, setState } from './state/store.ts';
import '@fontsource-variable/inter';
import './styles/app.css';
import 'highlight.js/styles/github-dark.css';

configureWs({
  onEvent: handleServerEvent,
  onOpen: () => void loadAll(),
  onStatus: (connected) => setState('connected', connected),
});
startWs();
restoreFromHash();

render(() => <App />, document.getElementById('root')!);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
