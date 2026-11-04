/** The backend's routes (server/main.ts serves them; the tests call them in-process). */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { ModelSync } from './model-sync';
import type { Registry } from './registry';

export function createApp(registry: Registry): Hono {
  const modelSync = new ModelSync();
  const app = new Hono();
  app.use('/api/*', compress());
  app.get('/api/index', (c) => c.json(registry.index()));
  app.post('/api/reload', async (c) => { await registry.load(); return c.json(registry.index()); });
  app.get('/api/domains/:id', (c) => {
    const d = registry.domain(c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'no such domain' }, 404);
  });
  app.get('/api/domains/:id/model', (c) => {
    const id = c.req.param('id');
    const m = registry.inputModel(id);
    if (m) { const f = modelSync.check(m, registry.packetOf(id)); if (f) m.freshness = f; }
    return m ? c.json(m) : c.json({ error: 'no input model in the packet (models/<domain>.json)' }, 404);
  });

  // (1.10.0) the data packets (server/packets.ts)
  app.get('/api/packets', (c) => c.json(registry.packets().map((p) => p.summary())));
  app.get('/api/packets/:id', (c) => {
    const p = registry.packet(c.req.param('id'));
    return p ? c.json(p.body()) : c.json({ error: 'no such packet' }, 404);
  });
  app.get('/api/packets/:id/verify/:name', (c) => {
    const p = registry.packet(c.req.param('id'));
    const name = c.req.param('name');
    if (!p || !['parts', 'causes', 'chains'].includes(name)) return c.json({ error: 'no such packet or file' }, 404);
    const body = p.verifyFile(name as 'parts' | 'causes' | 'chains');
    if (!body) return c.json({ error: `the packet ${p.id} has no verify ${name}` }, 404);
    c.header('Content-Type', 'application/json; charset=UTF-8');
    return c.body(body);
  });
  app.get('/api/packets/:id/sources/:tree', (c) => {
    const p = registry.packet(c.req.param('id'));
    if (!p) return c.json({ error: 'no such packet' }, 404);
    try { return c.json({ files: [...p.source(c.req.param('tree')).tree()] }); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });
  app.get('/api/packets/:id/sources/:tree/file', (c) => {
    const p = registry.packet(c.req.param('id'));
    if (!p) return c.json({ error: 'no such packet' }, 404);
    try { return c.json(p.source(c.req.param('tree')).file(c.req.query('path') ?? '')); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  app.get('/api/runs/:id', async (c) => {
    const r = await registry.run(c.req.param('id'));
    return r ? c.json(r) : c.json({ error: 'no such run' }, 404);
  });
  app.get('/api/runs/:id/designs', async (c) => {
    // DesignList {contract, runId, designs}; serialised (and gzipped) once per run, then served as is
    const body = await registry.designListBody(c.req.param('id'));
    if (!body) return c.json({ error: 'no such run' }, 404);
    c.header('Content-Type', 'application/json; charset=UTF-8');
    c.header('Vary', 'Accept-Encoding');
    if (/\bgzip\b/.test(c.req.header('Accept-Encoding') ?? '')) {
      c.header('Content-Encoding', 'gzip');
      return c.body(new Uint8Array(body.gzip));
    }
    return c.body(body.json);
  });
  app.get('/api/runs/:id/designs/:did', async (c) => {
    const d = await registry.design(c.req.param('id'), c.req.param('did'));
    return d ? c.json(d) : c.json({ error: 'no such design' }, 404);
  });
  app.get('/api/runs/:id/designs/:did/detail', async (c) => {
    const r = await registry.detail(c.req.param('id'), c.req.param('did'), c.req.query('simulate') === '1');
    c.header('X-Detail-Status', r.status);
    if (!r.detail) return c.json({ error: r.error ?? 'not simulated yet', status: r.status }, r.error ? 422 : 404);
    return c.json(r.detail);
  });
  return app;
}
