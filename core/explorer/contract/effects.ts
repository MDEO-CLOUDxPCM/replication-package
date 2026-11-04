/** Effect steps (docs/model.md, Call sites): labels and the join condition, shared by the exporters' consumers. */
import type { EffectMechanism, EffectState, JoinBlocker } from './types';

export const EFFECT_MECH_LABEL: Record<EffectMechanism, string> = { inTx: 'in transaction', sync: 'sync step', async: 'async message' };

/** why a step does not join its caller's transaction (core/mdeo/transform/realise/plan-placement.mt `pj`) */
export const JOIN_BLOCKER_LABEL: Record<JoinBlocker, string> = {
  apart: 'not co-located: caller and provider in different containers',
  servers: 'the two schemas on different database servers',
  orchestrated: 'a step of an orchestrated workflow (a saga step)',
  external: 'triggered from outside (provider callback): async only',
  chosen: 'another mechanism chosen',
};
export const JOIN_BLOCKER_SHORT: Record<JoinBlocker, string> = { apart: 'apart', servers: 'other DB server', orchestrated: 'orchestrated', external: 'external', chosen: 'other mechanism' };

/** what an effect step is in a design: joined (a local call inside the transaction), else its step form */
export function effectRealised(st: EffectState): string {
  if (st.joined) return 'joined: a local call inside the caller\'s transaction (no envelope, no commit, no message)';
  if (st.m === 'inTx') return `in transaction chosen, realised as a synchronous step (own transaction): ${JOIN_BLOCKER_LABEL[st.why ?? 'apart']}`;
  if (st.m === 'sync') return st.together ? 'a synchronous step in the same container: own transaction (envelope, commit), no hop' : 'a synchronous step: own transaction, the caller waits across the hop';
  return st.together ? 'an asynchronous message in process: own transaction, no broker' : 'an asynchronous message through the broker: own transaction';
}

/** short form: "joined", "sync step (apart)", "async" */
export function effectShort(st: EffectState): string {
  if (st.joined) return 'joined';
  if (st.m === 'inTx') return `sync step (${JOIN_BLOCKER_SHORT[st.why ?? 'apart']})`;
  return st.m === 'sync' ? 'sync step' : 'async message';
}
