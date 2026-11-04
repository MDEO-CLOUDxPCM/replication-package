import fs from 'node:fs';
import path from 'node:path';
import katex from 'katex';
import { describe, expect, it } from 'vitest';
import { REF_RELATIONS, refLink, refShort, type MetricDoc } from '../../../../core/explorer/web/src/lib/metricDocs';
import { parseTarget } from '../../../../core/explorer/web/src/lib/modelTarget';
import { packet } from '../config';
import { docs } from '../docs/metrics';

/** the MiSArch packet's metric docs (docs/metrics.ts) by key, as the popovers read them */
const METRIC_DOCS: Record<string, MetricDoc> = Object.fromEntries(docs.metrics.map((d) => [d.key, d]));
const RUNS = path.join(packet.out, 'runs');

/** every key the exported runs use (objectives, constraints, metrics) */
function runKeys(): string[] {
  if (!fs.existsSync(RUNS)) return [];
  const keys = new Set<string>();
  for (const r of fs.readdirSync(RUNS)) {
    const f = path.join(RUNS, r, 'run.json');
    if (!fs.existsSync(f)) continue;
    const run = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const x of [...run.objectives, ...run.constraints, ...run.metrics]) keys.add(x.key);
  }
  return [...keys];
}

describe('metric docs (the ? popovers)', () => {
  it('have one entry per key', () => {
    expect(Object.keys(METRIC_DOCS).length).toBe(docs.metrics.length);
  });
  it.skipIf(!fs.existsSync(RUNS))('explain every objective, constraint and metric of the exported runs', () => {
    const keys = runKeys();
    const missing = keys.filter((k) => !METRIC_DOCS[k]);
    expect(missing).toEqual([]);
  });
  it('explain the design table\'s, the colour\'s and the performance tiles\' figures', () => {
    for (const k of ['rank', 'feasible', 'born', 'services', 'perf.latencyBudget', 'perf.peakCapacity', 'perf.requests', 'perf.responseTime', 'perf.pods', 'perf.status']) expect(METRIC_DOCS[k], k).toBeTruthy();
  });
  it('every entry has a definition, its inputs and its sources; formulas render', () => {
    for (const d of Object.values(METRIC_DOCS)) {
      expect(d.summary.length, d.key).toBeGreaterThan(20);
      expect(d.inputs.length, d.key).toBeGreaterThan(0);
      expect(d.cite.length, d.key).toBeGreaterThan(0);
      for (const f of [...(d.formula ?? []), ...(d.where ?? []).map(([s]) => s)]) expect(() => katex.renderToString(f, { throwOnError: true, displayMode: true }), `${d.key}: ${f}`).not.toThrow();
      for (const l of d.links ?? []) expect(parseTarget(l.target), `${d.key}: ${l.target}`).not.toBeNull();
    }
  });
  it('every literature reference is complete and links to a DOI or URL', () => {
    for (const d of Object.values(METRIC_DOCS)) {
      for (const r of d.refs ?? []) {
        const at = `${d.key}: ${r.title}`;
        expect(r.authors.trim().length, at).toBeGreaterThan(0);
        expect(Number.isInteger(r.year) && r.year > 1900 && r.year <= 2026, at).toBe(true);
        expect(r.title.trim().length, at).toBeGreaterThan(3);
        expect(r.venue.trim().length, at).toBeGreaterThan(3);
        expect(REF_RELATIONS, at).toContain(r.relation);
        expect(Boolean(r.doi || r.url), at).toBe(true);
        if (r.doi) expect(r.doi, at).toMatch(/^10\.\d{4,9}\/\S+$/);
        if (r.url) expect(r.url, at).toMatch(/^https:\/\/\S+$/);
        expect(refLink(r), at).toMatch(/^https:\/\//);
        expect(refShort(r), at).toContain(String(r.year));
        if (r.relation !== 'source') expect(r.note?.length ?? 0, `${at}: say what is taken over or differs`).toBeGreaterThan(5);
      }
    }
  });
  it('say nothing of an analytic evaluation (every value comes from the simulation)', () => {
    const OLD = /ideal autoscaler|no-load|utilisation law|quota'?s? speed|node slowdown|pcm(Resources|Scenarios|Operations|CallRates|SourceFailure|Failure|Simulate)\b|LoadLevel|staticResponseTime/i;
    for (const d of Object.values(METRIC_DOCS)) expect(JSON.stringify(d), d.key).not.toMatch(OLD);
    expect(METRIC_DOCS.staticResponseTime).toBeUndefined();
  });
  it('objectives, constraints, metrics and search indicators say where their formula comes from', () => {
    for (const d of Object.values(METRIC_DOCS)) {
      if (!['objective', 'constraint', 'metric', 'search'].includes(d.kind)) continue;
      expect(Boolean(d.refs?.length || d.origin), d.key).toBe(true);
    }
  });
});
