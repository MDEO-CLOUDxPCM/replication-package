/**
 * Places in the Model panel, addressable in the URL as `model=<target>`:
 *   how | how:<section>        the overview: how a design is built, origin, parameters
 *   mech | mech:<kind>          the interactions and their mechanisms as sequence diagrams (fixed, read, write, event, callback, field, saga)
 *   param:<Class>               a decision-layer parameter (Reliability, CostModel, CachedCall, ...)
 *   domain | class:<id>         the domain model; a class
 *   ops | op:<id>               the operations; one operation
 *   workload | req:<id> | session:<id>   request types and sessions
 *   mm:<id> | mm:<id>/<Class>   a metamodel; a class of it
 *   verify | verify:<part>      the verification against the system's source; a part (model/verify/parts.ts keys)
 * The panel's tab follows the target (`mtab` overrides it when the user switches tabs).
 */
export type ModelTab = 'how' | 'mech' | 'domain' | 'ops' | 'workload' | 'mm' | 'verify';
export const MODEL_TABS: { id: ModelTab; label: string }[] = [
  { id: 'how', label: 'Overview' },
  { id: 'mech', label: 'Interactions' },
  { id: 'domain', label: 'Domain' },
  { id: 'ops', label: 'Operations' },
  { id: 'workload', label: 'Workload' },
  { id: 'mm', label: 'Metamodels' },
  { id: 'verify', label: 'Verify' },
];

export interface ModelTarget {
  kind: 'how' | 'mech' | 'param' | 'domain' | 'class' | 'ops' | 'op' | 'workload' | 'req' | 'session' | 'mm' | 'verify';
  id?: string;
  /** mm: the class */
  sub?: string;
}

export function parseTarget(s: string | null | undefined): ModelTarget | null {
  if (!s) return null;
  const i = s.indexOf(':');
  const kind = (i < 0 ? s : s.slice(0, i)) as ModelTarget['kind'];
  const rest = i < 0 ? undefined : s.slice(i + 1);
  if (!['how', 'mech', 'param', 'domain', 'class', 'ops', 'op', 'workload', 'req', 'session', 'mm', 'verify'].includes(kind)) return null;
  if (kind === 'mm' && rest) {
    const j = rest.indexOf('/');
    return j < 0 ? { kind, id: rest } : { kind, id: rest.slice(0, j), sub: rest.slice(j + 1) };
  }
  return rest ? { kind, id: rest } : { kind };
}

export function formatTarget(t: ModelTarget): string {
  if (!t.id) return t.kind;
  return t.kind === 'mm' && t.sub ? `mm:${t.id}/${t.sub}` : `${t.kind}:${t.id}`;
}

export function tabOf(t: ModelTarget | null): ModelTab {
  switch (t?.kind) {
    case 'class': case 'domain': return 'domain';
    case 'op': case 'ops': return 'ops';
    case 'req': case 'session': case 'workload': return 'workload';
    case 'mm': return 'mm';
    case 'verify': return 'verify';
    case 'mech': return 'mech';
    default: return 'how';
  }
}

export const opTarget = (id: string) => `op:${id}`;
export const classTarget = (id: string) => `class:${id}`;
export const reqTarget = (id: string) => `req:${id}`;
