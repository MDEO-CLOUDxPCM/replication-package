/**
 * The MiSArch packet's Verify builder (verify/): the parts, causes and chains it precomputes from package A's
 * extraction, the inventory, the workload, misarch-kotlin at the extraction's commit and the input model. Reads the
 * case's files (config.ts) and the packet's input model (config.ts `packet.out`, or VERIFY_MODEL): every test skips
 * when its inputs are missing. VERIFY_BASELINE=<dir with parts.json (the parts, or VerifyParts), causes.json,
 * chains.json> also compares the build with those for deep equality.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { InputModel } from '../../../../core/explorer/contract/types';
import type { Part, VerifyChains, VerifyParts } from '../../../../core/explorer/contract/verify';
import { SourceTreeReader } from '../../../../core/explorer/server/packets';
import { relatedCode } from '../../../../core/explorer/web/src/model/verify/related';
import { partEvidence } from '../../../../core/explorer/web/src/model/verify/SourcePane';
import { parseDocument, planNodes } from '../../../../core/explorer/web/src/model/verify/GraphqlDoc';
import { files, packet, sources } from '../config';
import { buildVerify, computeVerify, gitTree } from '../verify/build';
import { buildCauses } from '../verify/causes';
import { parseEvidence } from '../verify/claims';
import type { Extraction, Inventory } from '../verify/extraction';

const haveInputs = [files.extraction, files.inventory, files.workload].every((f) => fs.existsSync(f));
const A = haveInputs ? (JSON.parse(fs.readFileSync(files.extraction, 'utf8')) as Extraction) : undefined;
const INV = haveInputs ? (JSON.parse(fs.readFileSync(files.inventory, 'utf8')) as Inventory) : undefined;
const MODEL_FILE = process.env.VERIFY_MODEL ? path.resolve(process.env.VERIFY_MODEL) : path.join(packet.out, 'models', `${packet.domainId}.json`);
const model = haveInputs && fs.existsSync(MODEL_FILE) ? (JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')) as InputModel) : undefined;
let tree: Set<string> | undefined;
try { tree = A ? gitTree(sources.misarch.dir, A.meta.commit) : undefined; } catch { tree = undefined; }
const BASELINE = process.env.VERIFY_BASELINE;
/** the misarch-kotlin tree as the packet serves it */
const reader = A ? new SourceTreeReader('misarch', { kind: 'git', label: sources.misarch.label, path: '.', ref: A.meta.commit }, sources.misarch.dir) : undefined;
const project = new SourceTreeReader('project', { kind: 'dir', label: sources.project.label, path: '.', allow: sources.project.allow }, sources.project.dir);

describe.skipIf(!haveInputs)('Verify parts', () => {
  const vp = haveInputs ? computeVerify(model, tree).parts : ({ parts: [] } as unknown as VerifyParts);
  const parts = vp.parts;
  const byKind = (k: string) => parts.filter((p) => p.kind === k);

  it('covers every class, reference, operation, event, join and saga of the extraction', () => {
    expect(byKind('class')).toHaveLength(A!.classes.length);
    expect(byKind('ref')).toHaveLength(A!.references.length);
    expect(byKind('op')).toHaveLength(A!.operations.length);
    expect(byKind('event')).toHaveLength(A!.events.length);
    expect(byKind('join')).toHaveLength(A!.joins.length);
    expect(byKind('saga')).toHaveLength(A!.sagas.length);
    expect(new Set(parts.map((p) => p.key)).size).toBe(parts.length);
  });

  it('defines what the viewer shows of them: kinds, scopes, document kinds, lead facts, the tree and its commit', () => {
    expect(vp.kinds.map((k) => k.id)).toEqual(expect.arrayContaining([...new Set(parts.map((p) => p.kind))]));
    expect(Object.keys(vp.scopes)).toEqual(expect.arrayContaining([...new Set(parts.flatMap((p) => (p.scope ? [p.scope] : [])))]));
    expect(Object.keys(vp.docKinds!)).toEqual(expect.arrayContaining([...new Set(parts.flatMap((p) => p.docs.map((d) => d.kind)))]));
    const labels = new Set(byKind('op').flatMap((p) => p.facts.map((f) => f.label)));
    expect(vp.leadFacts!.op.filter((l) => labels.has(l)).length).toBeGreaterThan(5);
    expect(vp.lateGroups).toEqual(['cross-service', 'features', 'workload', 'parameters']);
    expect(vp.tree).toBe('misarch');
    expect(vp.commit).toBe(A!.meta.commit);
    // the evidence names the packet's source trees only
    const trees = new Set([...parts.flatMap(partEvidence), ...parts.flatMap((p) => p.docs.map((d) => d.loc))].map((l) => l.repo));
    expect([...trees].sort()).toEqual(['misarch', 'project']);
  });

  it.skipIf(!model)('marks the model\'s operations as simulated and adds its bindings and request types', () => {
    const sim = byKind('op').filter((p) => p.scope === 'simulated');
    expect(sim.map((p) => p.key.slice(3)).sort()).toEqual(model!.operations.map((o) => o.id).sort());
    expect(byKind('binding')).toHaveLength(model!.bindings.length);
    expect(byKind('req')).toHaveLength(model!.requests.length);
    // every part link points at a part
    const keys = new Set(parts.map((p) => p.key));
    const links = (p: Part) => [...p.facts.flatMap((f) => f.value), ...p.tables.flatMap((t) => t.rows.flatMap((r) => r.cells.flat()))]
      .flatMap((t) => (typeof t === 'object' && 'part' in t ? [t.part] : []));
    const dangling = parts.flatMap((p) => links(p).filter((k) => !keys.has(k)).map((k) => `${p.key} -> ${k}`));
    expect(dangling).toEqual([]);
  });

  it.skipIf(!model)('covers the features, the timings, the workload and the parameters', () => {
    expect(byKind('feature')).toHaveLength(A!.features.length);
    expect(byKind('timing')).toHaveLength(A!.msaMapping.operations.length);
    expect(byKind('session')).toHaveLength(model!.sessions.length);
    expect(byKind('profile')).toHaveLength(model!.profiles!.length);
    expect(byKind('param')).toHaveLength(new Set(model!.parameters.map((p) => p.class)).size);
    expect(byKind('workload').map((p) => p.key).sort()).toEqual(['workload:cardinalities', 'workload:data', 'workload:fragments', 'workload:think', 'workload:workloads']);
    // every simulated operation has its SEFF and a timing (seeded or the fallback)
    for (const p of byKind('op').filter((x) => x.scope === 'simulated')) {
      expect(p.seffs?.length, p.key).toBeGreaterThan(0);
      expect(p.facts.some((f) => f.label.startsWith('timing')), p.key).toBe(true);
    }
  });

  it('maps misarch-kotlin\'s inventories: every table, root field, entity type and subscription covered', () => {
    const cov = byKind('coverage');
    expect(cov.map((p) => p.group).sort()).toEqual(Object.keys(INV!.services).sort());
    const warn = (r: Part['tables'][number]['rows'][number]) => r.cells.flat().some((t) => typeof t === 'object' && 'chip' in t && t.tone === 'warn');
    const flagged = cov.flatMap((p) => p.tables.flatMap((t) => t.rows.filter(warn).map((r) => `${p.group} · ${t.title} · ${r.cells.map((c) => c.map((t) => (typeof t === 'string' ? t : 'part' in t ? t.label : 'code' in t ? t.code : t.chip)).join('')).join(' | ')}`)));
    for (const t of ['Tables (Flyway migrations)', 'GraphQL root fields and entity types', 'Subscriptions']) expect(flagged.filter((f) => f.includes(` · ${t} · `)), t).toEqual([]);
    expect(cov.reduce((n, p) => n + (p.flagged ?? 0), 0)).toBe(flagged.length);
  });

  it('keeps a fingerprint of the claims only: the same in two builds, not moved by rates', () => {
    const again = computeVerify(model, tree);
    expect(again.parts.parts.map((p) => [p.key, p.fp])).toEqual(parts.map((p) => [p.key, p.fp]));
    expect(Object.fromEntries(Object.entries(again.causes).map(([k, c]) => [k, c.rows.map((r) => r.fp)]))).toEqual(Object.fromEntries(Object.entries(computeVerify(model, tree).causes).map(([k, c]) => [k, c.rows.map((r) => r.fp)])));
    if (model) {
      const faster = { ...model, operations: model.operations.map((o) => ({ ...o, rate: o.rate * 2 })) };
      const op = model.operations[0].id;
      expect(computeVerify(faster, tree).parts.parts.find((p) => p.key === `op:${op}`)!.fp).toBe(parts.find((p) => p.key === `op:${op}`)!.fp);
    }
  });

  it.skipIf(!tree)('points its evidence at files of misarch-kotlin at the extraction\'s commit', () => {
    const outside = new Set(parts.flatMap(partEvidence).filter((l) => l.repo === 'misarch' && !tree!.has(l.path)).map((l) => l.path));
    // the request documents come from the load generator (timing/calibration, and the paths the extraction records
    // for its calibration's documents), not from misarch-kotlin
    expect([...outside].filter((p) => !p.startsWith('misarch-optimization/') && !p.startsWith('timing/calibration/'))).toEqual([]);
    const docs = parts.flatMap((p) => p.docs).filter((d) => d.loc.repo === 'misarch');
    expect(docs.filter((d) => !tree!.has(d.loc.path))).toEqual([]);
    // the project's documents are files the project tree serves
    const pdocs = parts.flatMap((p) => p.docs).filter((d) => d.loc.repo === 'project');
    expect(pdocs.filter((d) => !project.tree().has(d.loc.path)).map((d) => d.loc.path)).toEqual([]);
  });

  it.skipIf(!tree)('finds the anchor of most documents', () => {
    const text = new Map<string, string[]>();
    const lines = (repo: string, p: string) => {
      if (!text.has(`${repo}:${p}`)) text.set(`${repo}:${p}`, (repo === 'project' ? project : reader!).file(p).text.split('\n'));
      return text.get(`${repo}:${p}`)!;
    };
    let n = 0;
    const missed: string[] = [];
    for (const p of parts) for (const d of p.docs) {
      if (!d.find?.length) continue;
      n++;
      const ls = lines(d.loc.repo, d.loc.path);
      let at = 0;
      for (const f of d.find) { const i = ls.findIndex((l, k) => k >= at && new RegExp(f).test(l)); if (i < 0) { at = -1; break; } at = i; }
      if (at < 0) missed.push(`${p.key}: ${d.label} ${d.find.join(' / ')}`);
    }
    expect(missed.length / n).toBeLessThan(0.15);
  });

  it.skipIf(!tree)('its source trees serve the files at the commit and refuse others', () => {
    const f = reader!.file('reference/schemas/catalog.graphql');
    expect(f.commit).toBe(A!.meta.commit);
    expect(f.text).toContain('type Category');
    expect(() => reader!.file('no/such/file')).toThrow();
    expect(() => project.file('../etc/passwd')).toThrow();
    expect(() => project.file('docs/README.md')).toThrow();
    expect(project.file(files.docs.curated('catalog')).text).toContain('catalog.createCategory');
  });
});

describe.skipIf(!haveInputs || !model)('Verify causes', () => {
  const rows = (id: string) => { const o = A!.operations.find((x) => x.id === id)!; return buildCauses(A!, model!, o, model!.operations.find((x) => x.id === id)!).rows; };

  it('joins what an operation causes with the code', () => {
    const c = rows('order.createOrder');
    const call = c.find((r) => r.key === 'call:discount.findApplicableDiscounts')!;
    expect(call.ev[0]).toMatchObject({ repo: 'misarch', path: expect.stringContaining('CheckoutService.kt'), line: 165 });
    expect(c.find((r) => r.key === 'write:OrderItem')?.today).toBe('inTx');
    // the home as a decision: one row of its options, each candidate's write one row over all options
    expect(c.find((r) => r.kind === 'home')).toMatchObject({ allowed: ['Order', 'OrderItem'], today: 'Order' });
    // the home's own data is `own` (not `local`), its mechanism fixed, shown beside it
    expect(c.find((r) => r.key === 'write:Order')).toMatchObject({ allowed: ['own', 'sync', 'async', 'inTx'], today: 'own' });
    expect(c.find((r) => r.key === 'write:OrderItem')?.allowed).toContain('own');
    expect(c.some((r) => r.allowed.includes('local') || r.today === 'local')).toBe(false);
    // the own schema is rows too, the code facts the model has no interaction for rows with their reason
    const cd = rows('discount.createDiscount');
    expect(cd.find((r) => r.kind === 'home')).toMatchObject({ allowed: ['Discount'], today: 'Discount' });
    expect(cd.filter((r) => r.kind === 'write').map((r) => [r.via ?? r.cls, r.today]).sort()).toEqual([
      ['Discount', 'own'], ['Discount.discountAppliesToCategories', 'own'], ['Discount.discountAppliesToProductVariants', 'own'], ['Discount.discountAppliesToProducts', 'own']]);
    // a publish no reaction subscribes to feeds the copies of the stale-ok Discount reads of createCoupon and the
    // reservation check (no code-only row "no subscriber")
    expect(cd.find((r) => r.key === 'code:publish:discount/discount/created')).toBeUndefined();
    expect(cd.find((r) => r.key === 'copy:discount/discount/created')?.readers).toEqual(['discount.createCoupon', 'discount.on:inventory/product-item/reservation-succeeded']);
    // a call's row carries its level and its call site's mechanisms; a strict call stays sync only
    const fad = c.find((r) => r.key === 'call:discount.findApplicableDiscounts')!;
    expect(fad).toMatchObject({ allowed: ['sync', 'cache'], today: 'sync', consistency: { level: 'stale-ok', rules: ['R1', 'R2', 'I1'] } });
    expect(c.find((r) => r.key === 'call:shoppingcart._entities.User')).toMatchObject({ allowed: ['sync'], consistency: { level: 'strict', rules: ['S6'] } });
    expect(c.find((r) => r.key === 'read:User')?.consistency).toMatchObject({ level: 'immutable', rules: ['I1'] });
    expect(c.find((r) => r.key === 'read:Order')?.consistency).toBeUndefined();
    expect(c.some((r) => r.model.some((m) => /\bstrong\b/.test(m)))).toBe(false);
  });

  it('joins a publish only copy maintenance subscribes to with the copy feeds the operation writes into', () => {
    const cp = rows('catalog.createProduct');
    const created = cp.find((r) => r.key === 'copy:catalog/product/created')!;
    expect(created).toMatchObject({ kind: 'copy', topic: 'catalog/product/created' });
    expect(created.readers).toContain('discount.findApplicableDiscounts');
    expect(created.model.at(-1)).toMatch(/the copy sync adds a notification/);
    expect(created.ev.some((l) => l.label === 'publish')).toBe(true);
    expect(cp.some((r) => r.key === 'code:publish:catalog/product/created')).toBe(false);
    // a feed whose writer publishes nothing that feeds it: a row of its own
    const upd = rows('catalog.updateProductVariant').find((r) => r.key === 'copy:?ProductVariant')!;
    expect(upd.code[0]).toMatch(/no publish/);
    expect(upd.readers!.length).toBeGreaterThan(0);
  });

  it('gives every fact of the code a row: each access, call and publish of every modelled operation', () => {
    const mops = new Map(model!.operations.map((x) => [x.id, x]));
    for (const o of A!.operations.filter((x) => mops.has(x.id))) {
      const c = buildCauses(A!, model!, o, mops.get(o.id)!);
      const ev = new Set(c.rows.flatMap((r) => r.ev.map((l) => `${l.path}:${l.line}`)));
      for (const x of [...o.accesses, ...o.calls, ...o.publishes]) {
        for (const l of parseEvidence(x.evidence)) expect(ev.has(`${l.path}:${l.line}`), `${o.id}: ${l.path}:${l.line}`).toBe(true);
      }
    }
    const ev = rows('order.placeOrder').filter((r) => r.kind === 'event');
    expect(ev.map((r) => r.op).sort()).toEqual(['inventory.on:order/order/created', 'shoppingcart.on:order/order/created']);
    expect(ev[0].ev.some((l) => l.label === 'publish')).toBe(true);
  });

  it('finds every gateway plan entry in its request\'s GraphQL document', () => {
    for (const r of model!.requests.filter((x) => x.document)) {
      const d = parseDocument(r.document!);
      expect(d, r.id).not.toBeNull();
      const { at, entity } = planNodes(r, d!.roots);
      expect(at.size + entity.size, r.id).toBe(r.plan.length);
    }
  });
});

describe.skipIf(!haveInputs || !tree || !model)('Verify build', () => {
  it('writes parts, causes and chains into the packet; the chains link the calls from an operation\'s entry to its steps', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-build-'));
    try {
      const t0 = Date.now();
      const b = (await buildVerify({ out, model: model! }))!;
      console.log(`buildVerify: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      expect(b.setup).toEqual({ parts: 'verify/parts.json', causes: 'verify/causes.json', chains: 'verify/chains.json' });
      expect(b.commit).toBe(A!.meta.commit);
      expect(b.inputs).toEqual(expect.arrayContaining([files.extraction, files.inventory, files.workload, files.callgraph]));
      const read = (f: string) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
      const vp = read(b.setup.parts) as VerifyParts;
      const causes = read(b.setup.causes!);
      const chains = read(b.setup.chains!) as VerifyChains;
      expect(vp.parts.map((p) => p.fp)).toEqual(computeVerify(model, tree).parts.parts.map((p) => p.fp));
      expect(Object.keys(causes).sort()).toEqual(model!.operations.filter((o) => A!.operations.some((x) => x.id === o.id)).map((o) => `op:${o.id}`).sort());
      // the chains
      expect(Object.keys(chains).length).toBeGreaterThan(A!.operations.length * 0.9);
      expect(Object.values(chains).filter((c) => 'error' in c)).toEqual([]);
      const r = relatedCode(vp.parts.find((x) => x.key === 'op:address.createUserAddress')!, chains);
      // resolver -> service -> the repositories of its two accesses, in call order
      expect(r.fns.map((f) => f.label)).toEqual(['Mutation.createUserAddress', 'UserAddressService.createUserAddress', 'UserRepository.existsById', 'AddressRepository.save']);
      expect(r.fns[0].entry && r.fns[2].pm && r.fns[1].from === 'Mutation.createUserAddress').toBe(true);
      const call = r.calls.find((c) => c.to.key === 'UserAddressService.createUserAddress')!;
      const line = reader!.file(call.path).text.split('\n')[call.line - 1];
      expect(line.slice(call.col, call.col + call.len)).toBe('createUserAddress');
      expect(line.slice(0, call.col)).toMatch(/userAddressService\.$/);
      // every call site names its callee
      for (const [id, c] of Object.entries(chains)) {
        if ('error' in c) continue;
        for (const x of c.calls.slice(0, 5)) expect(x.to.split('.'), id).toContain(reader!.file(x.path).text.split('\n')[x.line - 1].slice(x.col, x.col + x.len));
      }
      expect(relatedCode(vp.parts.find((x) => x.kind === 'class')!, chains).fns).toEqual([]);
      // VERIFY_BASELINE: a reference build
      if (BASELINE) {
        const bp = JSON.parse(fs.readFileSync(path.join(BASELINE, 'parts.json'), 'utf8'));
        expect(isDeepStrictEqual(vp.parts, Array.isArray(bp) ? bp : bp.parts), 'parts').toBe(true);
        expect(isDeepStrictEqual(causes, JSON.parse(fs.readFileSync(path.join(BASELINE, 'causes.json'), 'utf8'))), 'causes').toBe(true);
        expect(isDeepStrictEqual(chains, JSON.parse(fs.readFileSync(path.join(BASELINE, 'chains.json'), 'utf8'))), 'chains').toBe(true);
      }
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  }, 120_000);
});
