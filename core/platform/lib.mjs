import { chromium } from 'playwright-core';
import fs from 'fs';
// the case's project on the platform (cases/<ARCH_CASE, default misarch>/platform.json `projectId`), or PID
export const PID = process.env.PID || JSON.parse(fs.readFileSync(new URL(`../../cases/${process.env.ARCH_CASE || 'misarch'}/platform.json`, import.meta.url), 'utf8')).projectId;
export const SHOTS = process.env.SHOTS || new URL('../../build/platform', import.meta.url).pathname;
// the workbench: BASE (default http://localhost:4242), login USER_NAME/PASSWORD (admin/admin)
const BASE = process.env.BASE || 'http://localhost:4242';
const STATE = new URL('../../build/platform/state.json', import.meta.url).pathname; // the session (not committed)
export async function open({ path = '/' + PID } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || (process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState: fs.existsSync(STATE) ? STATE : undefined });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(BASE + path);
  await page.waitForTimeout(4000);
  if (await page.locator('#login-username').count()) {
    await page.locator('#login-username').fill(process.env.USER_NAME || 'admin');
    await page.locator('#login-password').fill(process.env.PASSWORD || 'admin');
    await page.locator('button[type=submit]').click();
    await page.waitForTimeout(3000);
    await ctx.storageState({ path: STATE });
  }
  return { browser, ctx, page };
}
export async function shot(page, name) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png` }); console.log('shot', name); }
// GET/POST against the backend API with the page's session
export function api(page) {
  return (u, init) => page.evaluate(async ([u, init]) => { const r = await fetch(u, { credentials: 'include', ...(init || {}) }); return { s: r.status, t: await r.text() }; }, [u, init]);
}
