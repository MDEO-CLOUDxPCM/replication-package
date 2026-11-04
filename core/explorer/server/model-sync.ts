/**
 * The input model against its inputs (contract 1.5.0; since 1.10.0 through its packet, server/packets.ts): every
 * input the export recorded is hashed again (cached by size and mtime; paths relative to the packet's root
 * `project`); when one changed, the packet is rebuilt in the background by its `rebuild` command — only when the
 * local configuration allows it (else the state is `stale`). Realised seeds whose source model changed since they
 * were realised cannot be fixed here (the realisation runs elsewhere): they are reported, as is a model older than
 * what it was generated from (its `// Input: <path> sha256 <hex>` lines as the file is now).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { InputModel, ModelFreshness } from '../contract/types';
import { hashFile, type Packet } from './packets';

/** the packet root the input model's paths are relative to */
export const MODEL_ROOT = 'project';

export class ModelSync {
  private stamps = new Map<string, { key: string; inputs: { path: string; hash: string }[] }>();

  /** a generated model's `// Input: <path> sha256 <hex>` lines, as the file is now */
  private generatedFrom(f: string): { path: string; hash: string }[] {
    let st: fs.Stats;
    try { st = fs.statSync(f); } catch { return []; }
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = this.stamps.get(f);
    if (hit?.key === key) return hit.inputs;
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 20000));
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const inputs = [...buf.toString('utf8').matchAll(/^\/\/ Input: (\S+) sha256 ([0-9a-f]+)$/gm)].map((m) => ({ path: m[1], hash: m[2] }));
    this.stamps.set(f, { key, inputs });
    return inputs;
  }

  /**
   * the model's freshness; a changed input asks the packet to rebuild (a model without recorded hashes, or of a
   * packet without a manifest, is left alone)
   */
  check(model: InputModel, packet?: Packet | null): ModelFreshness | undefined {
    if (!packet || packet.implicit) return undefined;
    const inputs = model.inputs.filter((i) => i.hash);
    if (!inputs.length) return undefined;
    const base = packet.root(MODEL_ROOT);
    const same = (rel: string, h: string) => !!hashFile(path.resolve(base, rel))?.startsWith(h);
    const changed = inputs.filter((i) => !same(i.path, i.hash!)).map((i) => i.path);
    const unrealised = inputs.filter((i) => i.source && !same(i.source.path, i.source.hash)).map((i) => ({ seed: i.path, source: i.source!.path }));
    const ungenerated = [...new Set(inputs.filter((i) => i.source).map((i) => i.source!.path))]
      .map((m) => ({ model: m, inputs: this.generatedFrom(path.resolve(base, m)).filter((g) => !same(g.path, g.hash)).map((g) => g.path) })).filter((x) => x.inputs.length);
    // the model's changed inputs count as the packet's (the builder records them too); its rebuild exports the model
    // again, with the arguments the export recorded ({exportArgs} in the rebuild command)
    const pf = packet.freshness({ exportArgs: model.exportArgs ?? [] }, changed.map((c) => `${MODEL_ROOT}:${c}`));
    if (!changed.length) return { state: pf.state === 'updating' ? 'updating' : 'current', changed, unrealised, ungenerated };
    return { state: pf.state === 'current' ? 'stale' : pf.state, changed, unrealised, ungenerated, ...(pf.error ? { error: pf.error } : {}) };
  }
}
