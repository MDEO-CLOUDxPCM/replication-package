import type { Decisions, ReplicaDecision } from './types';

/** cyrb53: a fast 53-bit string hash (same result in Node and the browser). */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function replicaKey(r: ReplicaDecision): string {
  return r.mode === 'fixed' ? `f${r.count}` : `h${r.min}-${r.max}-${r.targetUtilisation}`;
}

/**
 * Canonical text of a design's decisions: independent of service ids, names and list order.
 * A service is identified by its sorted classes; databases by the services they hold.
 */
export function canonicalDecisions(d: Decisions): string {
  const key = new Map<string, string>();
  for (const s of d.services) key.set(s.id, [...s.classes].sort().join(','));
  const dbOf = new Map<string, string>();
  for (const db of d.databases) {
    const members = db.services.map((s) => key.get(s) ?? s).sort();
    for (const s of db.services) dbOf.set(s, `${db.placement}:${members.join(';')}`);
  }
  const services = d.services
    .map((s) => `${key.get(s.id)}|${replicaKey(s.replicas)}|${dbOf.get(s.id) ?? ''}`)
    .sort();
  const mechanisms = Object.entries(d.mechanisms)
    // an access within one service has no mechanism; a bundle may list one in the older spelling `local` (skipped: the hash stays)
    .filter(([, m]) => (m as string) !== 'local')
    .map(([k, m]) => `${k}=${m}`)
    .sort();
  const sagas = d.sagas
    .map((s) => `${s.process}=${s.style}${s.orchestrator ? '@' + key.get(s.orchestrator) : ''}`)
    .sort();
  const placement = Object.entries(d.operationPlacement ?? {})
    .map(([op, s]) => `${op}@${key.get(s) ?? s}`)
    .sort();
  return JSON.stringify({ services, mechanisms, sagas, placement });
}

export function designHash(d: Decisions): string {
  return cyrb53(canonicalDecisions(d));
}

/**
 * (1.5.0) a model's fingerprint as model data: its instances and links in order, the same for the same model whatever
 * file it was read from (a committed realised seed, a build's realised seed); without the simulation's replication
 * count, so a one-simulation seed (`-1sim`) has its model's fingerprint
 */
export function modelFingerprint(m: { instances: { name: string; className: string; properties?: Record<string, unknown> }[]; links: { sourceName: string; sourceProperty: string; targetName: string }[] }): string {
  const parts: string[] = [];
  for (const i of m.instances) {
    const props = Object.entries(i.properties ?? {}).filter(([k, v]) => k !== 'replications' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
    parts.push(`${i.name}:${i.className}${JSON.stringify(props)}`);
  }
  for (const l of m.links) parts.push(`${l.sourceName}.${l.sourceProperty}>${l.targetName}`);
  return cyrb53(parts.join('\n'));
}
