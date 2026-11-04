/**
 * The MiSArch packet's docs, collected from the modules in docs/ (each may export `texts`: key -> template,
 * `docs`: name -> data, `vocabulary`): texts are merged into the doc `texts`, a key or doc defined twice is an
 * error. build.ts writes them to <packet>/docs/<name>.json; tests use `packetBody()` to render with them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT_VERSION } from '../../../core/explorer/contract/types';
import type { PacketBody, PacketManifest, Vocabulary } from '../../../core/explorer/contract/packet';
import { dirs, files, packet, sources } from './config';

export const DOCS_DIR = path.join(dirs.builder, 'docs');

export async function loadDocs(): Promise<{ docs: Record<string, unknown>; texts: Record<string, string>; vocabulary: Vocabulary; modules: string[] }> {
  const modules = fs.readdirSync(DOCS_DIR).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts')).sort();
  const docs: Record<string, unknown> = {};
  const texts: Record<string, string> = {};
  const vocabulary: Vocabulary = {};
  for (const f of modules) {
    const m = (await import(pathToFileURL(path.join(DOCS_DIR, f)).href)) as { docs?: Record<string, unknown>; texts?: Record<string, string>; vocabulary?: Vocabulary };
    for (const [k, v] of Object.entries(m.texts ?? {})) {
      if (k in texts) throw new Error(`docs/${f}: the text ${k} is defined twice`);
      texts[k] = v;
    }
    for (const [k, v] of Object.entries(m.docs ?? {})) {
      if (k in docs || k === 'texts') throw new Error(`docs/${f}: the doc ${k} is defined twice`);
      docs[k] = v;
    }
    for (const [k, v] of Object.entries(m.vocabulary ?? {}) as [keyof Vocabulary, Vocabulary[keyof Vocabulary]][]) vocabulary[k] = [...(vocabulary[k] ?? []), ...(v ?? [])];
  }
  if (Object.keys(texts).length) docs.texts = texts;
  return { docs, texts, vocabulary, modules: modules.map((f) => path.join(DOCS_DIR, f)) };
}

/** the packet as GET /api/packets/misarch serves it, built in memory from the docs (no Verify, no commands allowed): for tests */
export async function packetBody(extra: Partial<PacketManifest> = {}): Promise<PacketBody> {
  const { docs, vocabulary } = await loadDocs();
  const manifest: PacketManifest = {
    contract: CONTRACT_VERSION, id: packet.id, name: packet.name, description: packet.description, family: packet.family, domains: [packet.domainId],
    vocabulary, docs: Object.fromEntries(Object.keys(docs).map((k) => [k, `docs/${k}.json`])),
    // the source trees as build.ts records them (labels; the git tree at the extraction's commit)
    sources: {
      misarch: { kind: 'git', label: sources.misarch.label, path: sources.misarch.dir, ref: fs.existsSync(files.extraction) ? String(JSON.parse(fs.readFileSync(files.extraction, 'utf8')).meta?.commit ?? '') : '', about: sources.misarch.about },
      project: { kind: 'dir', label: sources.project.label, path: sources.project.dir, allow: sources.project.allow, about: sources.project.about },
    },
    capabilities: { model: true, modelTabs: ['how', 'mech', 'domain', 'ops', 'workload', 'mm', 'verify'], verify: true, performance: true, simulate: true },
    ...extra,
  };
  return {
    contract: CONTRACT_VERSION, manifest, docs,
    summary: { id: manifest.id, name: manifest.name, family: manifest.family, domains: manifest.domains, capabilities: manifest.capabilities ?? {}, allowedCommands: [] },
  };
}
