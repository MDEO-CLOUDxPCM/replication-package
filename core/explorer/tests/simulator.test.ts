import { describe, expect, it } from 'vitest';
import { validate } from '../contract/validate';
import type { Design, Domain, Run } from '../contract/types';
import { constraintsOf, mapPluginDetail } from '../server/simulator';

/* eslint-disable @typescript-eslint/no-explicit-any */
// a minimal `palladio-sim-service detail` result (kind pcm-detail, evaluation = pcmEvaluate's PcmEvaluation as JSON):
// two request types on the gateway, one session class, one autoscaled service, a database server, two bins
const stat = (kind: string, extra: object, count: number, mean: number, pct: number[]) => ({
  kind, key: 'k', count, meanMs: mean, maxMs: pct[3] * 2, percentilesMs: pct,
  histogramEdgesMs: [1, 10, 100, 1000], histogramCounts: [count / 2, count / 2, 0],
  binCounts: [count / 2, count / 2], binMeanMs: [mean, mean], binPercentilesMs: [...pct, ...pct], ...extra,
});
const plugin = {
  kind: 'pcm-detail', version: 2, binS: 10, t: [0, 10, 20, 30],
  load: { t: [0, 10, 20, 30], baseRatePerS: { session_browser: 2, session_buyer: 1 }, factor: { session_browser: [1, 1, 2, 2], session_buyer: [1, 1, 1, 1] } },
  systemOperations: [{ signature: 'IGateway_products', name: 'products' }, { signature: 'IGateway_placeOrder', name: 'placeOrder' }],
  containers: [{ container: 'svc1', name: 'ProductService' }, { container: 'db1', name: 'ProductDatabase' }],
  resources: [{ resource: 'db1_cpu', container: 'db1', containerName: 'ProductDatabase', waitMs: 0.5, queueLength: 0.1 }],
  scenarios: [{ scenario: 'sc1', name: 'session_browser' }],
  assemblyOperations: [],
  simulator: { name: 'SimOxide', seed: 1, durationS: 40, warmUpS: 20 },
  evaluation: {
    failed: false, capped: false, timedOut: false, message: '', version: '2026-10-22+test', windowSeconds: 20, binSeconds: 10, bins: 2,
    percentiles: [50, 90, 95, 99], simulatedSeconds: 40, events: 1000, wallMs: 5,
    operations: [
      stat('systemOperation', { signature: 'IGateway_products' }, 100, 20, [10, 30, 40, 60]),
      stat('systemOperation', { signature: 'IGateway_placeOrder' }, 10, 50, [40, 80, 120, 150]),
    ],
    sessions: [stat('scenario', { scenario: 'sc1' }, 30, 900, [800, 1000, 1100, 1500])],
    resources: [
      { container: 'svc1', resource: 'svc1_cpu', kind: 'CPU', autoscaled: true, cores: 1, meanUtilisation: 0.5, binUtilisation: [0.4, 0.6], maxBinUtilisation: 0.6,
        meanReadyReplicas: 1.5, peakReadyReplicas: 2, binReadyReplicas: [1, 2], binReplicas: [1.5, 2], replicaCoreSeconds: 35, readyReplicaCoreSeconds: 30, rescales: 1, createdPods: 1, reversals: 0 },
      { container: 'db1', resource: 'db1_cpu', kind: 'CPU', autoscaled: false, cores: 1, meanUtilisation: 0.3, binUtilisation: [0.2, 0.9], maxBinUtilisation: 0.9,
        meanReadyReplicas: 1, peakReadyReplicas: 1, binReadyReplicas: [1, 1], binReplicas: [1, 1], replicaCoreSeconds: 20, readyReplicaCoreSeconds: 20, rescales: 0, createdPods: 0, reversals: 0 },
    ],
    callCounts: [], pathSets: [], pathSetsTruncated: false, createdPods: 1, rescales: 1, peakPods: 2, reversals: 0, warnings: [],
  },
};
const domain = { requests: [{ id: 'products', name: 'products', operations: [] }, { id: 'placeOrder', name: 'placeOrder', operations: [] }], operations: [], sessions: [] } as unknown as Domain;
const run = {
  id: 'r', config: {
    evaluation: {
      profile: 'day', warmUpS: 20, endS: 40, binS: 10, seed: 1, usageStreams: true, maxPods: 400, phases: [{ name: 'night', fromS: 0 }, { name: 'burst', fromS: 20 }],
      latency: { statistic: 'p95', factor: 1.5, minCompletions: 5, source: 'LatencyBudgetPolicy' },
      budgets: { products: { budgetMs: 50 }, placeOrder: { budgetMs: 100 } },
      peakCapacity: { limit: 0.85, binS: 10, containers: ['ProductDatabase'] }, pluginVersion: '2026-10-22+test',
    },
  },
} as unknown as Run;
const design = { id: 'd', hash: 'h', decisions: { services: [{ id: 'ProductService', name: 'ProductService', classes: [], replicas: { mode: 'hpa', min: 1, max: 5, targetUtilisation: 0.7 }, database: 'ProductDatabase' }], databases: [{ id: 'ProductDatabase', name: 'ProductDatabase', placement: 'own', services: ['ProductService'] }], mechanisms: {}, sagas: [] } } as unknown as Design;

describe('the plugin detail -> DesignDetail (contract 1.0.0)', () => {
  const d = mapPluginDetail(plugin, domain, run, design, 1);
  it('validates against the schema', () => {
    expect(validate('DesignDetail', d)).toEqual([]);
  });
  it('takes requests, sessions and scaling groups from the evaluation (the search\'s numbers)', () => {
    const p = d.requests.find((r) => r.key === 'products')!;
    expect(p).toMatchObject({ count: 100, meanMs: 20, p50Ms: 10, p90Ms: 30, p95Ms: 40, p99Ms: 60, budgetMs: 50, statisticMs: 40 });
    expect(p.overTime!.t).toEqual([20, 30]);
    expect(p.overTime!.throughput).toEqual([5, 5]);
    expect(d.sessions.map((s) => s.key)).toEqual(['browser']);
    expect(d.services).toHaveLength(1);
    expect(d.services[0]).toMatchObject({ service: 'ProductService', replicas: [1.5, 2], ready: [1, 2], rescales: 1 });
    expect(d.hpa).toMatchObject({ peakPods: 2, createdPods: 1, pods: [1.5, 2] });
    expect(d.resources.find((r) => r.peakCapacity)).toMatchObject({ kind: 'db', maxBinUtilisation: 0.9, waitMs: 0.5 });
    expect(d.phases).toEqual([{ name: 'night', fromS: 0, toS: 20 }, { name: 'burst', fromS: 20, toS: 40 }]);
    expect(d.load.sessionsPerSecond).toEqual([3, 3, 5, 5]);
    expect(d.simulator).toMatchObject({ version: '2026-10-22+test', durationS: 40, warmupS: 20, binS: 10, profile: 'day' });
  });
  it('recomputes C1 and C2 as metrics.fn does', () => {
    // C1: placeOrder p95 120 over its budget 100 -> 0.2; products 40 < 50; C2: 0.9 - 0.85
    expect(d.constraints!.latencyBudget).toBeCloseTo(0.2, 9);
    expect(d.constraints!.peakCapacity).toBeCloseTo(0.05, 9);
    expect(constraintsOf(true, d.requests, d.resources, run.config.evaluation)).toMatchObject({ latencyBudget: 1000, peakCapacity: 1 });
  });
  it('marks a failed or capped simulation', () => {
    const f = mapPluginDetail({ ...plugin, evaluation: { ...plugin.evaluation, capped: true, failed: false, message: 'pod limit' } } as any, domain, run, design, 1);
    expect(f.status).toMatchObject({ capped: true, message: 'pod limit' });
    expect(f.constraints).toMatchObject({ latencyBudget: 1000, peakCapacity: 1 });
  });
});
