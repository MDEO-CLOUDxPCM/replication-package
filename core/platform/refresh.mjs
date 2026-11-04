// usage: node refresh.mjs [<plugin url, default http://localhost:3022/>]   re-reads the plugin's
// manifest (after a new plugin build), as Settings → Plugins does
import { open, api } from './lib.mjs';
const url = process.argv[2] || 'http://localhost:3022/';
const { browser, page } = await open({ path: '/' });
const call = api(page);
const d = JSON.parse((await call('/api/plugins')).t);
const p = d.find(x => x.url === url);
if (!p) { console.log('no plugin registered at', url); process.exit(1); }
const res = await call(`/api/plugins/${p.id}/refresh`, { method: 'POST' });
console.log('refresh', p.id, p.name, res.s);
await browser.close();
