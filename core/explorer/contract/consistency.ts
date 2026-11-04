/**
 * Consistency levels (contract 1.13.0; docs/model.md, Call sites): how current a read or a call's answer must be, and
 * what that leaves of its mechanisms. Shared by the web views and the case packets' consumers.
 *
 *   strict     current data only: sync only (no call site; a strict read that today's code serves from the reader's
 *              own copy keeps sync / copy, never a cache)
 *   stale-ok   sync, a cache or a copy; O4 prices a stale answer by the data's write rate
 *   immutable  as stale-ok, but a stale answer cannot be wrong: no staleness cost (O4 p = 0 for a site whose reads
 *              are all immutable)
 *
 * `levelOf` accepts the older spelling `strong` (no copy or cache unless today's code uses a copy) as strict.
 */
import type { Consistency, ConsistencyLevel, Id, ModelOperation } from './types';

/** from the strictest: a group of accesses (one site per class and mode) takes its strictest access's level */
const RANK: Record<ConsistencyLevel, number> = { strict: 0, 'stale-ok': 1, immutable: 2 };

/** a read's or call's level: its `level`; the older spelling `strong` is strict; else stale-ok */
export const levelOf = (x: { level?: ConsistencyLevel; strong?: boolean }): ConsistencyLevel => x.level ?? (x.strong ? 'strict' : 'stale-ok');

export const strictest = (ls: ConsistencyLevel[]): ConsistencyLevel | undefined => (ls.length ? ls.reduce((a, b) => (RANK[b] < RANK[a] ? b : a)) : undefined);

/** generic texts (a packet's `InputModel.consistency.levels` replace them) */
export const LEVEL_ABOUT: Record<ConsistencyLevel, string> = {
  strict: 'must read current data: sync only (a copy only where today\'s code already reads its own store)',
  'stale-ok': 'a cache or a copy may serve it; O4 prices a stale answer by the data\'s write rate',
  immutable: 'a cache or a copy may serve it and a stale answer cannot be wrong: no staleness cost (O4 p = 0)',
};

/** an effect call: a change outside the system, reads nothing: sync only (E1) */
export const EFFECT_ABOUT = 'an effect call: it changes something outside the system and reads nothing, so it is sync only, never cached or copied';
export const LOCK_ABOUT = 'a statement that only locks: a strict read of the locked class, always on the current row at its own store';

/** several reads as one (a read group): the strictest level, the rules and reasons (one per line) at that level, any lock */
export const mergeConsistency = (xs: Consistency[]): Consistency | undefined => {
  const level = strictest(xs.map((x) => x.level));
  if (!level) return undefined;
  const at = xs.filter((x) => x.level === level);
  const rules = [...new Set(at.flatMap((x) => x.rules ?? []))];
  const reasons = [...new Set(at.map((x) => x.reason).filter((r): r is string => !!r))];
  return { level, ...(rules.length ? { rules } : {}), ...(reasons.length ? { reason: reasons.join('\n') } : {}), ...(xs.some((x) => x.lock) ? { lock: true } : {}) };
};

/**
 * the read group of an operation's reads of a class (their call site is shared): the strictest level, the rules and
 * reasons of its accesses at that level, whether one of them only locks; undefined without a read
 */
export function readConsistency(op: Pick<ModelOperation, 'accesses'> | undefined, cls: Id | undefined): Consistency | undefined {
  if (!op || !cls) return undefined;
  return mergeConsistency(op.accesses.filter((a) => a.class === cls && a.mode === 'read').map((a) => ({ level: levelOf(a), rules: a.rules, reason: a.reason, lock: a.lock })));
}

/** a call of another operation: its level, rules and reason */
export function callConsistency(op: Pick<ModelOperation, 'calls'> | undefined, callee: Id | undefined): Consistency | undefined {
  const c = op && callee ? op.calls.find((x) => x.callee === callee) : undefined;
  return c ? { level: c.level ?? (c.strong === false ? 'stale-ok' : 'strict'), ...(c.rules ? { rules: c.rules } : {}), ...(c.reason ? { reason: c.reason } : {}) } : undefined;
}

/** the reason's lines (several statements of one read group have one each) */
export const reasonLines = (r?: string) => (r ? r.split('\n') : []);

/** "strict · S2, S5" */
export const levelText = (c: Pick<Consistency, 'level' | 'rules'>) => `${c.level}${c.rules?.length ? ` · ${c.rules.join(', ')}` : ''}`;
