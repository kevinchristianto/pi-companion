import { createApp } from './app';
import { nativePlatform } from './platform';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing application root');
// The review import is eliminated from every production build, including builds with the env flag.
const platform = import.meta.env.DEV && __REVIEW_SERVE__
  ? (await import('./review')).reviewPlatform()
  : nativePlatform();
const app = createApp(root, platform);
window.addEventListener('pagehide', () => app.dispose(), { once: true });
