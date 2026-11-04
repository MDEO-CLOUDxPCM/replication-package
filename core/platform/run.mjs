// usage: node run.mjs <folder/sub/...> <config file name> <shot>   opens the folders in the tree,
// opens the config and presses the editor's Run button (the workbench POSTs /executions)
import { open, shot } from './lib.mjs';
const [folders, file, shotName] = process.argv.slice(2);
const { browser, page } = await open();
let posted = null;
page.on('response', async r => { if (r.url().includes('/executions') && r.request().method() === 'POST') { posted = r.status(); console.log('POST', r.url(), r.request().postData()?.slice(0, 300), '->', r.status(), (await r.text()).slice(0, 300)); } });
await page.waitForTimeout(3000);
for (const f of folders.split('/')) { await page.getByText(f, { exact: true }).first().click(); await page.waitForTimeout(1500); }
await page.waitForTimeout(5000);
await page.getByText(file, { exact: true }).first().dblclick();
await page.waitForTimeout(15000);
await shot(page, shotName + '-open');
const btn = page.locator('button[title*="Run" i], button[aria-label*="Run" i]');
console.log('run buttons', await btn.count());
if (await btn.count()) await btn.first().click(); else await page.mouse.click(1545, 20);
await page.waitForTimeout(5000);
await shot(page, shotName);
console.log('posted', posted);
await browser.close();
