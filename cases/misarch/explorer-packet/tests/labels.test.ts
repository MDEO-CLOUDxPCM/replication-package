// A mechanism is only a call site's decision; `local` is none. The built packet (pnpm packet:misarch)
// and the docs name every label the UI shows: the mechanisms, the placement badges (no hop, remote, own data) and the
// request plan's `via`. Skipped while the packet is not built.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InputModel } from '../../../../core/explorer/contract/types';
import type { PacketManifest } from '../../../../core/explorer/contract/packet';
import { packet } from '../config';
import { loadDocs } from '../docs';

const OUT = packet.out;
const have = fs.existsSync(path.join(OUT, 'packet.json'));
const json = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) as T;

describe.skipIf(!have)('labels of the built packet', () => {
  const manifest = have ? json<PacketManifest>('packet.json') : (null as never);
  const model = have ? json<InputModel>(`models/${packet.domainId}.json`) : (null as never);

  it('has no `local` mechanism: not in the vocabulary, the sites or the Verify causes', () => {
    expect((manifest.vocabulary?.mechanisms ?? []).map((m) => m.id)).not.toContain('local');
    expect((manifest.vocabulary?.edges ?? []).map((m) => m.id)).not.toContain('local');
    for (const s of model.sites) {
      expect(s.allowed, s.id).not.toContain('local');
      for (const seed of ['today', 'neutral', 'monolith'] as const) expect(s[seed], s.id).not.toBe('local');
    }
    const causes = json<Record<string, { rows: { allowed: string[]; today?: string }[] } | { allowed: string[]; today?: string }[]>>('verify/causes.json');
    for (const [k, v] of Object.entries(causes)) for (const r of Array.isArray(v) ? v : v.rows) {
      expect(r.allowed, k).not.toContain('local');
      expect(r.today, k).not.toBe('local');
    }
  });

  it('names every mechanism a site may choose in the vocabulary', () => {
    const ids = new Set((manifest.vocabulary?.mechanisms ?? []).map((m) => m.id));
    for (const s of model.sites) for (const m of s.allowed) expect(ids.has(m), `${s.id}: ${m}`).toBe(true);
  });

  it("writes the request plan's via in the explorer's words: root, service, gateway", () => {
    for (const r of model.requests) for (const p of r.plan) expect(['root', 'service', 'gateway'], `${r.id} ${p.op}`).toContain(p.via);
    for (const s of model.sites) if (s.kind === 'field') expect(['service', 'gateway'], s.id).toContain(s.planVia);
    // orderTracking: the order's items in its own service, its shipments fetched by the gateway
    expect(model.requests.find((r) => r.id === 'orderTracking')!.plan.map((p) => p.via)).toEqual(['root', 'service', 'gateway']);
  });

  it('documents the placement badges once (Interactions) and in their tooltips (texts)', async () => {
    const { docs, texts } = await loadDocs();
    const pd = (docs.interactions as { placement?: Record<string, string> }).placement!;
    for (const k of ['intro', 'noHop', 'remote', 'own']) expect(pd[k], k).toBeTruthy();
    expect(pd.noHop).toMatch(/\*\*no hop\*\*/);
    expect(pd.remote).toMatch(/\*\*remote → /);
    expect(pd.remote).toMatch(/crosses the hop/);
    expect(pd.remote).toMatch(/receiving envelope/);
    expect(pd.own).toMatch(/\*\*own data\*\*/);
    // own data always with its fixed mechanism: a read sync, a write in transaction
    expect(pd.own).toMatch(/\*\*sync\*\*.*\*\*in transaction\*\*/);
    for (const x of [pd.own, texts['placement.own']]) expect(x).not.toMatch(/no mechanism/);
    for (const k of ['placement.noHop', 'placement.remote', 'placement.own']) expect(texts[k], k).toBeTruthy();
  });
});
