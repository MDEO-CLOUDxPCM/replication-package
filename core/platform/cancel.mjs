// usage: node cancel.mjs <execution id>   cancels a running execution of the project
import { open, api, PID } from './lib.mjs';
const { browser, page } = await open();
const r = await api(page)(`/api/projects/${PID}/executions/${process.argv[2]}/cancel`, { method: 'POST' });
console.log('cancel', process.argv[2], r.s, r.t.slice(0, 200));
await browser.close();
