// The case packets' builders live with their cases (cases/<case>/explorer-packet/, the repository's docs/case-interface.md), outside this
// package: their imports of npm packages (vitest, ...) resolve through a link to this package's node_modules beside
// each of them (gitignored), made after every install (pnpm postinstall) and before the packet scripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPLORER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = path.resolve(EXPLORER, '../../cases');
const modules = path.join(EXPLORER, 'node_modules');
for (const c of fs.existsSync(CASES) ? fs.readdirSync(CASES) : []) {
  const dir = path.join(CASES, c, 'explorer-packet');
  if (!fs.existsSync(dir)) continue;
  const link = path.join(dir, 'node_modules');
  const want = path.relative(dir, modules);
  let have = null;
  try { have = fs.readlinkSync(link); } catch { /* none */ }
  if (have === want) continue;
  if (have !== null || fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(want, link);
  console.log(`linked ${path.relative(EXPLORER, link)} -> ${want}`);
}
