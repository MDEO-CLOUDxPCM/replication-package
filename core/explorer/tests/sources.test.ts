import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BundleSource } from '../sources/bundle';
import { validateBundle } from '../contract/validate';
import { writeDesignsJsonl } from '../contract/jsonl';
import { CONTRACT_VERSION, type Design, type Run } from '../contract/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-sources-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function design(i: number, runId: string): Design {
  return {
    id: `d${i}`, runId, hash: `h${i}`, label: i % 3 ? undefined : `design ünïcødé ${i}`, objectives: [i, 100 - i, i * 0.5], constraints: [0], feasible: true, rank: 0,
    metrics: { services: i % 7 }, hasDecisions: true,
    decisions: {
      services: [{ id: 's1', name: `svc ${i}`, classes: ['A', 'B'], replicas: { mode: 'fixed', count: 1 + (i % 3) }, database: 'db1' }],
      mechanisms: { [`op${i}|A|read`]: 'sync' }, sagas: [], databases: [{ id: 'db1', name: 'db', placement: 'own', services: ['s1'] }],
    },
  };
}

function minimalRun(id: string): Run {
  return {
    contract: CONTRACT_VERSION, id, name: id, source: { kind: 'bundle', location: 'test' }, problem: 'static', domainId: 'dom',
    algorithm: 'NSGA-II', status: 'completed', createdAt: '2026-10-19T00:00:00Z', populationSize: 1, generations: 1, evaluated: 1, designCount: 1,
    objectives: [{ key: 'a', label: 'A', direction: 'minimize' }, { key: 'b', label: 'B', direction: 'minimize' }, { key: 'c', label: 'C', direction: 'minimize' }],
    constraints: [{ key: 'x', label: 'X' }], metrics: [], config: { populationSize: 1, generations: 1, operators: [] }, history: [],
  } as Run;
}

describe('bundle source', () => {
  it('designs.jsonl: summaries without decisions, design() by id equals the original, preferred over designs.json', async () => {
    const root = path.join(tmp, 'bundle');
    const dir = path.join(root, 'runs', 'r1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(minimalRun('r1')));
    const designs = Array.from({ length: 3000 }, (_, i) => design(i, 'r1'));
    writeDesignsJsonl(path.join(dir, 'designs.jsonl'), { contract: CONTRACT_VERSION, runId: 'r1' }, designs);
    // a stale designs.json must be ignored
    fs.writeFileSync(path.join(dir, 'designs.json'), JSON.stringify({ contract: '0.1.0', runId: 'r1', designs: designs.slice(0, 2) }));
    const s = new BundleSource({ id: 'b', kind: 'bundle', path: root }, tmp);
    await s.load();
    expect(s.status()).toMatchObject({ ok: true, runs: 1 });
    const list = (await s.designs('r1'))!;
    expect(list).toHaveLength(3000);
    expect(list.some((d) => 'decisions' in d || 'rawDecisions' in d)).toBe(false);
    const { decisions: _d, ...summary } = designs[1234];
    expect(list[1234]).toEqual(summary);
    for (const i of [0, 1, 2999, 1500, 777]) expect(await s.design('r1', `d${i}`)).toEqual(designs[i]);
    expect(await s.design('r1', 'nope')).toBeNull();
    expect(await s.design('nope', 'd1')).toBeNull();
  });

  it('designs.jsonl: lines across read chunks, CRLF, empty lines', async () => {
    const { scanJsonl } = await import('../contract/jsonl');
    const f = path.join(tmp, 'x.jsonl');
    const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ i, pad: 'é'.repeat(i % 37) }));
    fs.writeFileSync(f, lines[0] + '\r\n\n' + lines.slice(1).join('\n'));
    const seen: number[] = [];
    const buf = fs.readFileSync(f);
    await scanJsonl(f, (v, off, len) => {
      seen.push((v as { i: number }).i);
      expect(JSON.parse(buf.toString('utf8', off, off + len))).toEqual(v);
    }, 64);
    expect(seen).toEqual(lines.map((_, i) => i));
  });

  it('designs.json still works; a missing bundle directory is fine', async () => {
    const root = path.join(tmp, 'bundle-json');
    const dir = path.join(root, 'runs', 'r2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(minimalRun('r2')));
    const designs = Array.from({ length: 10 }, (_, i) => design(i, 'r2'));
    fs.writeFileSync(path.join(dir, 'designs.json'), JSON.stringify({ contract: CONTRACT_VERSION, runId: 'r2', designs }));
    const s = new BundleSource({ id: 'b', kind: 'bundle', path: root }, tmp);
    await s.load();
    expect((await s.designs('r2'))!.every((d) => !('decisions' in d))).toBe(true);
    expect(await s.design('r2', 'd4')).toEqual(designs[4]);

    const missing = new BundleSource({ id: 'missing', kind: 'bundle', path: 'no-such-bundle' }, path.join(tmp, 'nowhere'));
    await missing.load();
    expect(missing.status()).toMatchObject({ ok: true, runs: 0, message: 'nothing exported yet' });
  });

  it('validateBundle reads designs.jsonl', () => {
    const root = path.join(tmp, 'bundle');
    fs.mkdirSync(path.join(root, 'domains'), { recursive: true });
    const errs = validateBundle(root);
    expect(errs.filter((e) => e.includes('designs'))).toEqual([]);
  });
});
