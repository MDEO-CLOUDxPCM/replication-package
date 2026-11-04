// usage: node api.mjs <METHOD> <path> [json body]   one backend API call with the workbench's session
import { open, api } from './lib.mjs';
const [method, path, body] = process.argv.slice(2);
const { browser, page } = await open({ path: '/' });
const init = { method };
if (body) { init.body = body; init.headers = { 'Content-Type': 'application/json' }; }
const r = await api(page)(path, init);
console.log(r.s); console.log(r.t);
await browser.close();
