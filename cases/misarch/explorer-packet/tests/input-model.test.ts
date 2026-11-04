import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMetamodel } from '../../../../core/explorer/contract/metamodel';
import { validate } from '../../../../core/explorer/contract/validate';
import type { InputModel } from '../../../../core/explorer/contract/types';
import { formatTarget, parseTarget, tabOf } from '../../../../core/explorer/web/src/lib/modelTarget';

import { dirs, files } from '../config';

const ROOT = dirs.explorer;
const EXPORTER = path.join(dirs.builder, 'export-model.ts');
// a build of core/tools/run-domain.sh (PREP_ONLY=1): the realised seeds of the current model (core/tools/realise-seeds.sh's)
const BUILD = path.resolve(dirs.build, process.env.EXPLORER_TEST_BUILD ? path.relative('build', process.env.EXPLORER_TEST_BUILD) : 'realise');
const SEEDS = path.join(BUILD, 'realised');
/** a metamodel's (first) file, from the config */
const read = (id: string) => fs.readFileSync(files.metamodels.find((m) => m.id === id)!.files[0], 'utf8');
const haveMetamodels = files.metamodels.every((m) => m.files.every((f) => fs.existsSync(f)));

describe.skipIf(!haveMetamodels)('metamodel parser', () => {
  it('reads classes, attributes, supertypes and references of the layers', () => {
    const d = parseMetamodel(read('domain'));
    expect(d.classes.map((c) => c.name)).toEqual(expect.arrayContaining(['Domain', 'DomainClass', 'Operation', 'Access', 'Binding']));
    expect(d.enums.find((e) => e.name === 'AccessShape')?.literals).toEqual(['ONE', 'OPTIONAL', 'LIST', 'BATCH', 'PER_ITEM']);
    expect(d.references).toContainEqual(expect.objectContaining({ source: 'Domain', name: 'classes', multiplicity: '1..*', kind: 'containment', target: 'DomainClass', opposite: 'domain' }));
    expect(d.references).toContainEqual(expect.objectContaining({ source: 'DomainEvent', name: 'reactions', kind: 'bidirectional', target: 'Operation', opposite: 'trigger', oppositeMultiplicity: '0..1' }));
    // a read's consistency level beside the extraction's flag
    expect(d.classes.find((c) => c.name === 'Access')?.attributes.map((a) => a.name)).toEqual(['mode', 'shape', 'count', 'rows', 'strong', 'level', 'cpuMs', 'dbMs']);
    expect(d.enums.find((e) => e.name === 'ConsistencyLevel')?.literals).toEqual(['STRICT', 'STALE_OK', 'IMMUTABLE']);
    const a = parseMetamodel(read('architecture'));
    const mech = a.classes.find((c) => c.name === 'Mechanism')!;
    expect(mech.abstract).toBe(true);
    expect(mech.attributes.find((x) => x.name === 'staleReads')).toMatchObject({ type: 'double', multiplicity: '?' });
    expect(a.classes.find((c) => c.name === 'CachedCall')?.supers).toEqual(['Mechanism']);
    expect(a.references).toContainEqual(expect.objectContaining({ source: 'CallSite', name: 'allowed', multiplicity: '1..*', kind: 'reference', target: 'Mechanism' }));
    expect(a.sections).toEqual(expect.arrayContaining(['Homes', 'Evaluation', 'Copy sync trace', 'Realisation trace']));
    // each class its own doc: PeakCapacity's apart from ObjectiveBound's
    expect(a.classes.find((c) => c.name === 'PeakCapacity')?.doc).toMatch(/^C2: containers that no autoscaler scales/);
    expect(a.classes.find((c) => c.name === 'ObjectiveBound')?.doc).toMatch(/^An objective as a constraint/);
    const p = parseMetamodel(read('palladio'));
    expect(p.views.map((v) => v.name)).toContain('Behaviour');
    expect(p.classes.find((c) => c.name === 'CompositeComponent')?.supers).toEqual(['ComposedStructure', 'ImplementationComponentType']);
  });
});

describe('model targets', () => {
  it('round-trip and pick their tab', () => {
    for (const s of ['op:order.placeOrder', 'class:Order', 'req:address.createUserAddress', 'mm:architecture/CallSite', 'mm:palladio', 'param:Reliability', 'how', 'op:inventory.on:order/order/created']) expect(formatTarget(parseTarget(s)!)).toBe(s);
    expect(tabOf(parseTarget('op:x'))).toBe('ops');
    expect(tabOf(parseTarget('mm:domain/Access'))).toBe('mm');
    expect(parseTarget('nonsense:x')).toBeNull();
  });
});

describe('input model export (contract 1.0.0)', () => {
  const have = fs.existsSync(path.join(SEEDS, 'domain-neutral.model.json'));
  it.skipIf(!have)('exports the derived model and validates against the schema', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-test-model-'));
    try {
      execFileSync(process.execPath, ['--import', 'tsx', EXPORTER, '--build', BUILD, '--out', out], { cwd: ROOT, stdio: 'pipe' });
      const m = JSON.parse(fs.readFileSync(path.join(out, 'models/misarch-kotlin-derived.json'), 'utf8')) as InputModel;
      expect(validate('InputModel', m)).toEqual([]);
      expect(m.classes).toHaveLength(31);
      expect(m.operations.length).toBeGreaterThan(60);
      expect(m.requests.length).toBe(35);
      expect(m.metamodels.map((x) => x.id)).toEqual(['domain', 'architecture', 'palladio']);
      const seffs = new Set(m.seffs.map((s) => s.id));
      // every request starts at a gateway SEFF; every call part points at a SEFF of the model
      for (const r of m.requests) expect(seffs.has(r.seff), r.id).toBe(true);
      for (const s of m.seffs) for (const p of s.parts) if (p.t === 'call') expect(p.to && seffs.has(p.to), `${s.id} ${p.name}`).toBe(true);
      // every call site belongs to an operation or request and has its options
      for (const s of m.sites) { expect(s.op ?? s.request, s.id).toBeTruthy(); expect(s.allowed.length, s.id).toBeGreaterThan(0); }
      // rates: an operation's rate is Σ request rate × visits; the root of a request runs once per request
      const rate = new Map(m.requests.map((r) => [r.id, r.rate]));
      for (const o of m.operations) expect(o.rate).toBeCloseTo(o.reach.reduce((s, x) => s + (rate.get(x.request) ?? 0) * x.visits, 0), 3);
      const po = m.operations.find((o) => o.id === 'order.placeOrder')!;
      expect(po.reach).toContainEqual({ request: 'placeOrder', visits: 1 });
      expect(po.homeClass).toBe('Order');
      // call-site links (0.4.0): an event site names the raise it realises, a field site its plan entry, a copy its feed
      const ops = new Map(m.operations.map((o) => [o.id, o]));
      const reqs = new Map(m.requests.map((r) => [r.id, r]));
      for (const s of m.sites) {
        if (s.kind === 'event') {
          expect(ops.get(s.op!)!.raises.map((r) => r.event), s.id).toContain(s.event);
          expect(ops.get(s.callee!)!.reactsTo, s.id).toBe(s.event);
        }
        if (s.kind === 'field') expect(reqs.get(s.request!)!.plan.map((p) => ({ op: p.op, via: p.via })), s.id).toContainEqual({ op: s.callee, via: s.planVia });
        expect(!!s.copyFeed, s.id).toBe(s.allowed.includes('copy'));
        // every writer of a copy writes the copied class
        for (const w of s.copyFeed?.writers ?? []) expect(ops.get(w.op)!.accesses.some((a) => a.class === s.class && a.mode === 'write'), `${s.id} ${w.op}`).toBe(true);
      }
      // 63 copy feeds: one per site that allows a copy (the stale-ok and immutable reads of another class; the reads of
      // a service's own data in a copy table, such as the callback's open-order reads and shipment's return-shipment
      // read of its order items, are none)
      expect(m.sites.filter((s) => s.copyFeed).length).toBe(63);
      // 3 of them without writers
      expect(m.sites.filter((s) => s.copyFeed && !s.copyFeed.writers.length).length).toBe(3);
      // the load profile with its steps per session type and C's phases
      expect(m.profiles?.map((x) => x.id)).toEqual(['day']);
      const day = m.profiles!.find((x) => x.id === 'day')!;
      expect(day.steps.length).toBeGreaterThan(9);
      expect(day.phases.map((x) => x.name)).toContain('sale');
      expect(day.warmUpS).toBeLessThan(day.endS);
      for (const st of day.steps) if (st.session) expect(m.sessions.map((x) => x.id), st.session).toContain(st.session);
      expect(Object.keys(day.baseRates).length).toBeGreaterThan(3);
      // C1: a budget is the policy's factor × today's simulated statistic under the same profile
      for (const p of m.profiles!) {
        const bs = m.requests.flatMap((r) => r.budgets ?? []).filter((b) => b.profile === p.id);
        expect(bs.length, p.id).toBeGreaterThan(5);
        for (const b of bs) {
          expect(b.statistic).toBe(p.latency.statistic);
          if (p.latency.factor && b.budgetMs !== undefined && b.referenceMs) expect(b.budgetMs / b.referenceMs).toBeCloseTo(p.latency.factor, 3);
          if (p.latency.minCompletions && (b.referenceCount ?? 0) < p.latency.minCompletions) expect(b.budgetMs).toBeUndefined();
        }
      }
      // nothing of the analytic evaluation
      expect(m.parameters.some((x) => x.class === 'LoadLevel' || x.class === 'Node')).toBe(false);
      expect(m.origin.some((o) => /static/.test(o.path))).toBe(false);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('input model: timing, caches, waits, transaction workflows, effect steps (contract 1.1.0–1.4.0)', () => {
  const have = fs.existsSync(path.join(SEEDS, 'domain-neutral.model.json'));
  it.skipIf(!have)('exports the timing source, mapping CPU, site caches, waits and the transaction workflows', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-test-model-'));
    try {
      execFileSync(process.execPath, ['--import', 'tsx', EXPORTER, '--build', BUILD, '--out', out], { cwd: ROOT, stdio: 'pipe' });
      const m = JSON.parse(fs.readFileSync(path.join(out, 'models/misarch-kotlin-derived.json'), 'utf8')) as InputModel;
      expect(validate('InputModel', m)).toEqual([]);
      expect(m.domainId).toBe('misarch-kotlin-derived');
      expect(m.timing?.source).toBe('campaign-v3');
      expect(m.timing!.label).toMatch(/k_c applied/);
      const seffs = new Map(m.seffs.map((s) => [s.id, s]));
      const ops = new Map(m.operations.map((o) => [o.id, o]));
      // the home class's mapping split out of `work`: own work = Operation.cpuMs, the split part = mapCpuMs
      for (const o of m.operations) for (const sid of o.seffs) {
        const s = seffs.get(sid);
        // an alternative home's SEFFs run the same work at another class: the written option's carry the timing
        if (s?.kind !== 'operation' || (s.home && !s.home.written)) continue;
        const own = s.parts.find((p) => p.t === 'work' && p.name === 'work');
        // (1.4.0) the campaign measures a reaction's work without its envelope: the work is the whole own CPU, the step
        // form's envelope comes on top; (1.11.0) the receiving envelope of today's cross-service invocation is not in the work
        if (own) expect(own.ms! + (o.envelopeMs ?? 0), sid).toBeCloseTo(o.cpuMs, 3);
        const map = s.parts.find((p) => p.split);
        expect(map?.ms ?? 0, sid).toBeCloseTo(o.mapCpuMs ?? 0, 4);
      }
      expect(m.operations.filter((o) => o.mapCpuMs).length).toBeGreaterThan(30);
      expect(m.seffs.filter((s) => s.kind === 'access' && s.parts.some((p) => p.name === 'map')).length).toBeGreaterThan(30);
      // the campaign's mechanism parameters (readCpuMs 0.59 ms / 4.023 copy reads)
      expect(m.parameters.find((p) => p.class === 'LocalCopy')!.properties).toMatchObject({ readDbMs: 0.141, readCpuMs: 0.1467, writeCpuMs: 1.083, writeDbMs: 0.321 });
      // (1.2.0) the families, of the sites as written (a home option's sites are inert while another option is chosen);
      // 14 writes bound; package A's topic roles
      const live = m.sites.filter((s) => !s.home || s.home.written);
      // 81 fetch sites: 63 reads of another class, 14 fields and 4 calls of another operation that are not strict
      // (S21-S23 at today's home, S21's nested inventoryCount)
      expect(live.filter((s) => s.family === 'fetch').length).toBe(81);
      expect(live.filter((s) => s.kind === 'call').map((s) => s.family)).toEqual(['fetch', 'fetch', 'fetch', 'fetch']);
      const eff = live.filter((s) => s.family === 'effect');
      // 34 effect sites (the own-data writes of payment's and shipment's handlers and createReturn's returnedWithId are local)
      expect(eff.length).toBe(34);
      for (const s of eff) expect(s.effect, s.id).toBeDefined();
      expect(eff.filter((s) => s.effect!.bound).length).toBe(14);
      for (const s of eff.filter((x) => x.effect!.bound)) expect(s.kind === 'access' && s.mode === 'write', s.id).toBe(true);
      expect(eff.filter((s) => s.effect!.external).map((s) => s.kind)).toEqual(['callback', 'callback', 'callback']);
      for (const s of eff.filter((x) => x.kind === 'event')) expect(s.effect!.cascades, s.id).toBeDefined();
      const roles = (m.topics ?? []).reduce<Record<string, number>>((a, t) => ({ ...a, [t.role]: (a[t.role] ?? 0) + 1 }), {});
      expect(roles).toEqual({ replication: 13, process: 9, mixed: 4, unsubscribed: 8 });
      for (const s of m.sites.filter((x) => x.allowed.includes('copy'))) expect(s.copyTopics, s.id).toBeDefined();
      // latency waits, per-site caches and the provider's cache as built
      expect(m.parameters.find((p) => p.class === 'Latency')?.properties).toMatchObject({ stmtRoundTripMs: 0.2653, commitDelayMs: 3.563, publishWaitMs: 2.7859 });
      expect(m.seffs.filter((s) => s.kind === 'db' && s.parts.some((p) => p.resource === 'DELAY')).length).toBeGreaterThan(100);
      expect(m.requests.find((r) => r.id === 'product')!.work.wait).toBeGreaterThan(0);
      const hit = m.sites.filter((s) => s.hitRatio !== undefined);
      expect(hit.length).toBeGreaterThan(20);
      for (const s of hit) expect(s.allowed.some((x) => x === 'cache' || x === 'joinCache'), s.id).toBe(true);
      const built = m.sites.filter((s) => s.cachedService);
      expect(built.length).toBeGreaterThan(10);
      for (const s of built) {
        const c = seffs.get(s.cachedSeff!)!;
        expect(c.kind, s.id).toBe('cache');
        // hit: the provider's CPU; miss: the field's own operation, through the provider's federation fetch
        // a hit whose lookup is 0 ms (the measured hit is the provider's receiving envelope) has no part: then the
        // miss's call carries 1 - hit ratio
        const hitPart = c.parts.find((p) => p.name === 'cacheHit');
        if (hitPart) expect(hitPart.p ?? 0, s.id).toBeCloseTo(s.hitRatio!, 4);
        else expect(c.parts.find((p) => p.t === 'call')?.p ?? 1, s.id).toBeCloseTo(1 - s.hitRatio!, 4);
        const reaches = (id: string | undefined): boolean => { const x = id ? seffs.get(id) : undefined; return !!x && (x.op === s.callee || (x.kind === 'fetch' && x.parts.some((p) => p.t === 'call' && reaches(p.to)))); };
        expect(c.parts.some((p) => p.t === 'call' && reaches(p.to)), s.id).toBe(true);
        expect(ops.has(s.callee!), s.id).toBe(true);
      }
      // (1.11.0) receiving envelopes: one SEFF each (kind envelope, one `envelope` work part, measured); the calls into
      // their services carry envelopeMs, none into a step form, a commit or a request's root
      const envs = m.envelopes ?? [];
      expect(envs.length).toBe(26);
      const envOf = new Map(envs.flatMap((e) => e.services.map((sg) => [`${e.component}:${sg}`, e] as const)));
      for (const e of envs) {
        const x = seffs.get(e.seff!)!;
        expect(x.kind, e.id).toBe('envelope');
        expect(x.parts.map((p) => p.name), e.id).toEqual(['envelope']);
        expect(x.parts[0].ms!, e.id).toBeCloseTo(e.ms, 3);
        expect(e.estimate, e.id).toBe(false);
      }
      const withEnv = m.seffs.flatMap((s) => s.parts.filter((p) => p.t === 'call' && p.envelopeMs !== undefined).map((p) => ({ s, p })));
      expect(withEnv.length).toBeGreaterThan(50);
      for (const { s, p } of withEnv) {
        const t = seffs.get(p.to!)!;
        expect(['step', 'commit', 'gateway'].includes(t.kind) || p.kind === 'root', `${s.id} ${p.name}`).toBe(false);
        expect(envOf.get(`${t.component}:${t.signature}`)?.ms, `${s.id} ${p.name}`).toBeCloseTo(p.envelopeMs!, 4);
      }
      const co = seffs.get('Order_reqCreateOrder')!;
      expect(co.parts.filter((p) => p.kind === 'call').map((p) => Number(p.envelopeMs!.toFixed(4)))).toEqual([1.0324, 1.2226, 1.4616, 0.852]); // the callee envelopes × k_c
      // (1.3.0) the transaction workflows with 14 steps, one per bound write, next to the 3 sagas; no commit blocks of
      // their own (a separated step commits in its step form; no `transactional` field)
      // (1.4.0) effect steps: 31 sites (14 writes, all bound, 17 events) reach 28 distinct step forms, inTx allowed on
      // all of them, not on the 3 callbacks; joined in today, neutral and monolith exactly at the 14 bound writes
      const stepSites = eff.filter((s) => s.effect!.step);
      expect(stepSites.length).toBe(31);
      expect(new Set(stepSites.map((s) => s.effect!.step!.seff)).size).toBe(28);
      // 38 commits: the step forms' and the home options' own; the steps of writes measured only inside another
      // statement commit too
      expect(m.seffs.filter((s) => s.kind === 'commit').length).toBe(38);
      for (const s of eff) expect(s.allowed.includes('inTx'), s.id).toBe(!s.effect!.external);
      for (const s of stepSites) {
        const st = s.effect!.step!;
        const form = seffs.get(st.seff)!;
        expect(form.kind, s.id).toBe('step');
        expect(form.parts.map((p) => p.kind ?? p.name).slice(0, 2), s.id).toEqual(['envelope', 'work']);
        expect(!!form.parts[0].estimate, s.id).toBe(false);
        expect(st.envelopeMs, s.id).toBeGreaterThan(0);
        if (st.commit) expect(seffs.get(st.commit)?.kind, s.id).toBe('commit');
        expect(st.work, s.id).toBe(form.parts[1].to);
        if (s.kind === 'event') expect(seffs.get(st.work)?.op, s.id).toBe(s.callee);
        else expect(seffs.get(st.work)?.class, s.id).toBe(s.class);
      }
      for (const seed of ['today', 'neutral', 'monolith'] as const) {
        expect(eff.filter((s) => s.effect!.joined?.[seed] === true).map((s) => s.id).sort(), seed).toEqual(eff.filter((s) => s.effect!.bound).map((s) => s.id).sort());
      }
      expect(eff.filter((s) => s.effect!.external).every((s) => s.effect!.joined?.today === 'external')).toBe(true);
      expect(m.timing!.envelope?.source).toBe('measured-v3');
      expect(m.parameters.some((p) => p.class === 'InTransaction')).toBe(true);
      // the transaction workflows of the written homes (a home option's workflow is inert while another is chosen)
      const txs = m.processes.filter((p) => { const h = p.transaction && seffs.get(p.transaction.seff)?.home; return !!p.transaction && (!h || h.written); });
      expect(m.processes.filter((p) => !p.transaction).map((p) => p.id).sort()).toEqual(['Buy', 'Registration', 'Return']);
      expect(txs.length).toBe(10);
      const steps = txs.flatMap((p) => p.transaction!.sites);
      expect(new Set(steps).size).toBe(14);
      expect(new Set(steps)).toEqual(new Set(eff.filter((s) => s.effect!.bound).map((s) => s.id)));
      for (const p of txs) {
        expect(p.id).toBe(p.workflow);
        expect(p.styles.sort()).toEqual(['choreography', 'orchestration']);
        expect(p.today, p.id).toBe('choreography');
        expect(seffs.get(p.transaction!.seff)?.op, p.id).toBe(p.trigger);
        for (const sid of p.transaction!.sites) {
          const site = m.sites.find((s) => s.id === sid)!;
          expect(site.op, sid).toBe(p.trigger);
          expect(p.transaction!.writes, sid).toContain(site.class);
        }
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('input model: homes as a decision, network delay', () => {
  const have = fs.existsSync(path.join(SEEDS, 'domain-neutral.model.json'));
  it.skipIf(!have)('exports the homes with their option SEFFs, the inert sites and networkMs', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-test-model-'));
    try {
      execFileSync(process.execPath, ['--import', 'tsx', EXPORTER, '--build', BUILD, '--out', out], { cwd: ROOT, stdio: 'pipe' });
      const m = JSON.parse(fs.readFileSync(path.join(out, 'models/misarch-kotlin-derived.json'), 'utf8')) as InputModel;
      expect(validate('InputModel', m)).toEqual([]);
      const homes = m.homes ?? [];
      // the request roots whose home is a decision and the reaction shoppingcart.on:order/order/created, each with alternatives
      expect(homes.length).toBeGreaterThan(1);
      for (const h of homes) expect(h.options.length, h.op).toBeGreaterThanOrEqual(2);
      expect(homes.find((h) => h.op === 'shoppingcart.on:order/order/created')?.options.map((o) => o.seffs?.length).sort()).toEqual([2, 2]);
      const seffs = new Map(m.seffs.map((s) => [s.id, s]));
      for (const h of homes) {
        expect(h.today, h.op).toBe(h.written);
        expect(m.operations.find((o) => o.id === h.op)?.homeClass, h.op).toBe(h.written);
        for (const o of h.options) for (const sf of o.seffs ?? []) expect(seffs.get(sf)?.home, `${h.op} ${o.class} ${sf}`).toEqual({ op: h.op, class: o.class, written: o.class === h.written });
      }
      // today's sites and the alternative homes' sites, inert while not chosen
      expect(m.sites.filter((s) => s.home && !s.home.written).length).toBeGreaterThan(0);
      expect(m.sites.filter((s) => !s.home || s.home.written).length).toBeGreaterThan(0);
      expect(m.parameters.find((p) => p.class === 'RemoteCalls')?.properties.networkMs).toBe(0.1);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
