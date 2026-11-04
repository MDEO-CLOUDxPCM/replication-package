/**
 * Explorer backend: serves the index, runs, designs and domains from the configured sources and packets, an
 * on-demand detail endpoint (precomputed -> cache -> simulator), and per packet (server/packets.ts) its manifest
 * with its docs, its Verify files and its source trees.
 *
 *   EXPLORER_API_PORT (5181), EXPLORER_CACHE (../../build/explorer-cache), EXPLORER_SIMULATOR (auto | dummy | palladio-plugin),
 *   EXPLORER_SOURCES (another sources file), EXPLORER_PACKETS (more packet directories),
 *   EXPLORER_LOCAL_CONFIG / EXPLORER_ALLOW_COMMANDS (the commands packets may run, server/local-config.ts)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { Registry } from './registry';
import { makeSimulator } from './simulator';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.EXPLORER_API_PORT ?? 5181);
const CACHE = path.resolve(ROOT, process.env.EXPLORER_CACHE ?? '../../build/explorer-cache');

const simulator = makeSimulator(CACHE);
const registry = new Registry(ROOT, CACHE, simulator);
await registry.load();
const app = createApp(registry);

// production: the built frontend
const DIST = path.join(ROOT, 'dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(DIST)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), DIST) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')));
}

serve({ fetch: app.fetch, port: PORT }, () => {
  const idx = registry.index();
  console.log(`explorer api on http://localhost:${PORT} (simulator: ${simulator.name}); ${idx.runs.length} runs`);
  for (const s of idx.sources) console.log(`  source ${s.id} [${s.kind}, ${s.mode}] ${s.ok ? 'ok' : 'FAILED'} ${s.runs} runs${s.message ? ' - ' + s.message : ''}`);
  for (const p of idx.packets ?? []) console.log(`  packet ${p.id} (${p.name}${p.family ? `, ${p.family}` : ''})${p.implicit ? ' implicit' : ''}; commands allowed: ${p.allowedCommands.join(', ') || 'none'}${p.stale ? `; STALE: ${p.stale.join(', ')}` : ''}`);
});
