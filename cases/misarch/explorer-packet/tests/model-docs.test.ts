// The MiSArch packet's Model-panel docs (docs/how.ts, docs/interactions.ts, docs/texts-model.ts): well-formed templates
import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../../../core/explorer/web/src/lib/packet';
import { loadDocs } from '../docs';

/** every `{{#x}}` / `{{^x}}` closed by its `{{/x}}`, properly nested */
function balanced(tpl: string): boolean {
  const stack: string[] = [];
  for (const m of tpl.matchAll(/\{\{([#^/])(\w+)\}\}/g)) {
    if (m[1] !== '/') stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

/** every string inside a doc */
const strings = (x: unknown): string[] => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(strings) : x && typeof x === 'object' ? Object.values(x).flatMap(strings) : []);

describe('Model panel docs', () => {
  it('has balanced template sections and leaves no tag behind', async () => {
    const { docs, texts } = await loadDocs();
    const all = [...Object.entries(texts).filter(([k]) => k.startsWith('model.')).map(([k, v]) => [k, v] as const),
      ...strings(docs.how).map((v) => ['how', v] as const), ...strings(docs.interactions).map((v) => ['interactions', v] as const)];
    expect(all.length).toBeGreaterThan(50);
    for (const [k, v] of all) {
      expect(balanced(v), `${k}: ${v.slice(0, 60)}`).toBe(true);
      for (const flags of [{}, { a: 1 }]) expect(renderTemplate(v, flags), k).not.toMatch(/\{\{|\}\}/);
    }
  });

  it('gives every How step an origin step and every realisation row three cells', async () => {
    const { docs } = await loadDocs();
    const how = docs.how as { steps: { origin: string }[]; realise: { rows: string[][] } };
    expect(how.steps.every((s) => s.origin)).toBe(true);
    expect(how.realise.rows.every((r) => r.length === 3)).toBe(true);
  });
});
