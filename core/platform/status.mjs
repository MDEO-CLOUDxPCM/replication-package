// lists the project's executions (id, state, file, created)
import { open, api, PID } from './lib.mjs';
const { browser, page } = await open();
const r = await api(page)(`/api/projects/${PID}/executions`);
let d = JSON.parse(r.t); d = Array.isArray(d) ? d : (d.items || d);
for (const e of d) console.log(e.id, e.state, e.filePath, e.createdAt || '', e.startedAt || '', e.finishedAt || e.completedAt || '');
await browser.close();
