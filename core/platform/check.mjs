// usage: node check.mjs <dir/file>[=shot] ...   opens the folders, then each file; reports error
// markers of the editor and red entries of the tree
import { open, shot } from './lib.mjs';
const files = process.argv.slice(2);
const { browser, page } = await open();
await page.waitForTimeout(3000);
for (const f of (process.env.FOLDERS || 'models,optimize').split(',')) { const e = page.getByText(f, { exact: true }).first(); if (await e.count()) { await e.click(); await page.waitForTimeout(700); } }
await page.waitForTimeout(15000);
console.log('tree red:', JSON.stringify(await page.locator('.text-destructive').allInnerTexts()));
for (const f of files) {
  const [name, shotName] = f.split('=');
  await page.getByText(name, { exact: true }).first().dblclick();
  await page.waitForTimeout(12000);
  const squig = await page.locator('.squiggly-error').count();
  const red = await page.locator('.text-destructive').allInnerTexts();
  console.log(`${name}: squiggly-error=${squig} red=${JSON.stringify(red)}`);
  if (shotName) await shot(page, shotName);
}
await browser.close();
