// downloads every optimisation execution of the project (summary, report.json, solution models)
// to build/platform/executions/<config name>/.
// OUT=<dir> writes elsewhere; BYID=1 names directories <config>-<execution id prefix>; SINCE=<ISO time> takes only executions created from then on.
import { open, api, PID } from './lib.mjs';
import fs from 'fs';
const OUT = process.env.OUT || new URL('../../build/platform/executions', import.meta.url).pathname;
const SINCE = process.env.SINCE || '';
const IDS = (process.env.IDS || '').split(',').filter(Boolean);
const P = `/api/projects/${PID}/executions`;
const { browser, page } = await open();
const get = api(page);
let list = JSON.parse((await get(P)).t); list = Array.isArray(list) ? list : list.items;
for (const e of list.filter((e) => e.filePath.endsWith('.config') && (!SINCE || (e.createdAt || '') >= SINCE) && (!IDS.length || IDS.some((i) => e.id.startsWith(i))))) {
  const base = e.filePath.split('/').pop().replace('.config', '');
  // BYID=1: one directory per execution (a config run several times)
  const name = process.env.BYID ? `${base}-${e.id.slice(0, 8)}` : base;
  const dir = `${OUT}/${name}`; fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/execution.json`, (await get(`${P}/${e.id}`)).t);
  const sum = await get(`${P}/${e.id}/summary`);
  fs.writeFileSync(`${dir}/summary.json`, sum.t);
  try { fs.writeFileSync(`${dir}/summary.md`, JSON.parse(sum.t).summary); } catch {}
  let n = 0;
  // one batch: the files sit at the top (report.json, solution_i.m_gen); several: batch_N/
  const top = await get(`${P}/${e.id}/files/report.json`);
  for (let b = 1; b <= 3; b++) {
    const rep = top.s === 200 ? (b === 1 ? top : { s: 404 }) : await get(`${P}/${e.id}/files/batch_${b}/report.json`);
    if (rep.s !== 200) break;
    fs.mkdirSync(`${dir}/batch_${b}`, { recursive: true });
    fs.writeFileSync(`${dir}/batch_${b}/report.json`, rep.t);
    for (const s of JSON.parse(rep.t).paretoFront) {
      const f = await get(`${P}/${e.id}/files/${s.path}`);
      if (f.s !== 200) { console.log('missing', s.path); continue; }
      fs.writeFileSync(`${dir}/batch_${b}/${s.path.split('/').pop()}`, f.t); n++;
    }
  }
  console.log(name, e.id, e.state, 'solutions', n);
}
await browser.close();
