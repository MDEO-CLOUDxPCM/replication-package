import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate, validateBundle, validateManifest } from '../contract/validate';
import { designHash } from '../contract/hash';
import { dominates, hypervolume, ranks } from '../contract/pareto';
import { CONTRACT_VERSION, type Decisions, type Design, type Domain } from '../contract/types';
import type { PacketManifest } from '../contract/packet';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/packet-tiny');

describe('contract', () => {
  it('a freshly generated dummy bundle (over the fixture\'s domain) validates against the schema', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-test-bundle-'));
    try {
      execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'dummy/generate.ts'), '--small', '--domain', path.join(FIXTURE, 'domains/bookshop.json'), '--out', out], { cwd: ROOT, stdio: 'pipe' });
      expect(validateBundle(out)).toEqual([]);
      expect(fs.readdirSync(path.join(out, 'domains'))).toEqual(['bookshop.json']);
      expect(fs.readdirSync(path.join(out, 'runs')).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('the fixture packet\'s documents validate: bundle, manifest, the detail of its design', () => {
    expect(validateBundle(FIXTURE)).toEqual([]);
    const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURE, f), 'utf8')) as T;
    const m = read<PacketManifest>('packet.json');
    expect(validateManifest(m)).toEqual([]);
    expect(validateManifest({ ...m, capabilities: { model: 'yes' } })).not.toEqual([]);
    expect(m.contract).toBe(CONTRACT_VERSION);
    expect(m.family).toBeUndefined();
    expect(m.sources).toBeUndefined();
    expect(m.commands).toBeUndefined();
    for (const f of Object.values(m.docs ?? {})) expect(fs.existsSync(path.join(FIXTURE, f)), f).toBe(true);
    expect(validate('Domain', read<Domain>(`domains/${m.domains[0]}.json`))).toEqual([]);
    // the precomputed detail is the one of a design's decisions
    const runs = fs.readdirSync(path.join(FIXTURE, 'runs'));
    for (const r of runs) {
      const designs = read<{ designs: Design[] }>(`runs/${r}/designs.json`).designs;
      for (const d of designs) expect(designHash(d.decisions!), d.id).toBe(d.hash);
      const details = fs.readdirSync(path.join(FIXTURE, 'runs', r, 'details'));
      expect(details.length).toBeGreaterThan(0);
      for (const f of details) {
        const det = read<{ designHash: string }>(`runs/${r}/details/${f}`);
        expect(validate('DesignDetail', det)).toEqual([]);
        expect(f).toBe(`${det.designHash}.json`);
        expect(designs.find((d) => d.hash === det.designHash)?.hasDetail).toBe(true);
      }
    }
    // small: well under 100 kB
    const size = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
    expect(size(FIXTURE)).toBeLessThan(80_000);
  }, 60_000);

  it('rejects a run without objectives directions', () => {
    const errs = validate('Run', { id: 'x', objectives: [{ key: 'cost', label: 'Cost' }] });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('design hash ignores service ids, names and order', () => {
    const a: Decisions = {
      services: [
        { id: 's1', name: 'Order', classes: ['Order', 'OrderItem'], replicas: { mode: 'fixed', count: 2 }, database: 'db1' },
        { id: 's2', name: 'Catalog', classes: ['Product'], replicas: { mode: 'fixed', count: 1 }, database: 'db2' },
      ],
      mechanisms: { 'createOrder|Product|read': 'copy' },
      sagas: [],
      databases: [{ id: 'db1', name: 'a', placement: 'own', services: ['s1'] }, { id: 'db2', name: 'b', placement: 'own', services: ['s2'] }],
    };
    const b: Decisions = {
      services: [
        { id: 'x', name: 'catalog service', classes: ['Product'], replicas: { mode: 'fixed', count: 1 }, database: 'd' },
        { id: 'y', name: 'order service', classes: ['OrderItem', 'Order'], replicas: { mode: 'fixed', count: 2 }, database: 'e' },
      ],
      mechanisms: { 'createOrder|Product|read': 'copy' },
      sagas: [],
      databases: [{ id: 'e', name: 'e', placement: 'own', services: ['y'] }, { id: 'd', name: 'd', placement: 'own', services: ['x'] }],
    };
    expect(designHash(a)).toBe(designHash(b));
    expect(designHash(a)).not.toBe(designHash({ ...a, mechanisms: { 'createOrder|Product|read': 'sync' } }));
    // (1.12.0) `local` is no mechanism any more; a bundle before it that listed one keeps its hash
    const old = { ...a, mechanisms: { ...a.mechanisms, 'createOrder|Order|write': 'local' } } as unknown as Decisions;
    expect(designHash(old)).toBe(designHash(a));
  });

  it('pareto helpers', () => {
    expect(dominates([1, 1], [2, 2])).toBe(true);
    expect(dominates([1, 2], [2, 1])).toBe(false);
    expect(ranks([[1, 1], [2, 2], [1, 3], [3, 3]])).toEqual([0, 1, 1, 2]);
    const hv = hypervolume([[0.5, 0.5]], [0, 0], [1, 1], 4000);
    expect(hv).toBeGreaterThan(0.23);
    expect(hv).toBeLessThan(0.27);
  });
});
