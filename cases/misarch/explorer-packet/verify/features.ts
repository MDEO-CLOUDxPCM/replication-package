/**
 * Feature parts: A's features (curated/global.yaml: msa's 28 and F0, each operation's `feature`), the operations that
 * belong to each and which of them the model keeps (core/generator/derive.py: the features of the simulated and the
 * coupling-only operations; domain.mm Feature, for group moves and change coupling).
 */
import { chip, esc, OP_SCOPE, parseEvidence, type Ctx } from './claims';
import { files } from '../config';

export function featureParts(ctx: Ctx) {
  const { a, ops, scopeOf, opLink, docs, add } = ctx;
  for (const f of a.features) {
    const members = f.operations.map((id) => ops.get(id)).filter((o) => !!o);
    const inModel = members.filter((o) => ['simulated', 'coupling'].includes(scopeOf(o)));
    // operations naming this feature that the feature's list misses (and the reverse) would be an inconsistency of A
    const naming = a.operations.filter((o) => o.feature === f.code).map((o) => o.id);
    const missing = naming.filter((id) => !f.operations.includes(id));
    add({
      key: `feature:${f.code}`, kind: 'feature', group: 'features', title: `${f.code} ${f.name}`, subtitle: `${members.length} operations, ${inModel.length} in the model`,
      facts: [
        { label: 'name', value: [f.name] },
        { label: 'origin', value: [f.msa ? 'one of the msa model\'s 28 features' : f.code === 'F0' ? 'not assigned: no msa feature fits' : 'new (not in the msa model)'] },
        { label: 'in the model', value: inModel.length ? [`a Feature with ${inModel.length} operations (the simulated and coupling-only ones): group moves and change coupling`] : [chip('not in the model', 'muted'), ' none of its operations is'] },
        ...(missing.length ? [{ label: 'check', value: [chip('inconsistent', 'warn'), ` ${missing.length} operations name ${f.code} but are not in its list: ${missing.join(', ')}`] }] : []),
      ],
      tables: [{ title: 'Operations', columns: ['operation', 'service', 'kind', 'in the model'], rows: members.map((o) => {
        const sc = scopeOf(o);
        return { cells: [[opLink(o.id)], [o.service], [o.kind], [chip(OP_SCOPE[sc].label, sc === 'simulated' ? 'ok' : 'muted')]], ev: parseEvidence(o.entry, 'entry') };
      }) }],
      docs: [docs.project('curated', files.docs.curated('global'), [`^\\s+${esc(f.code)}:`]), docs.project('report', files.docs.report, [`\\b${esc(f.code)}\\b`])],
    });
  }
}
