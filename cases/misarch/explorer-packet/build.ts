/**
 * The MiSArch packet builder: `pnpm packet:misarch [--out <dir>] [--only model,docs,verify]
 * [--link-runs <bundle>] [-- <export-model args>]`. Writes into the packet directory (config.ts `packet.out`,
 * default build/explorer-sim, where `pnpm export:run` exports runs):
 *
 *   models/<domain>.json   the input model (export-model.ts)
 *   docs/*.json            the case's texts, metric docs, How pipeline, Interactions examples (docs/*.ts here)
 *   verify/*.json          the Verify tab's parts, causes and chains (verify/build.ts)
 *   packet.json            the manifest: roots, source trees, commands, capabilities, vocabulary, measures, inputs
 *
 * Every path it reads comes from config.ts. `--link-runs <bundle>` links the runs (and domains) of another bundle
 * into the packet (a packet built elsewhere than the export directory, e.g. for a check).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InputModel } from '../../../core/explorer/contract/types';
import { CONTRACT_VERSION } from '../../../core/explorer/contract/types';
import { FAMILY_PALLADIO, type MeasureDef, type ModelTabId, type PacketInput, type PacketManifest } from '../../../core/explorer/contract/packet';
import { dirs, files, packet, rel, sources } from './config';
import { buildVerify } from './verify/build';
import { loadDocs } from './docs';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const args = dash >= 0 ? argv.slice(0, dash) : argv;
/** the export arguments to pass on (the model's recorded exportArgs on a rebuild), without --out */
const exportArgs = (dash >= 0 ? argv.slice(dash + 1) : []).filter((a, i, xs) => a !== '--out' && xs[i - 1] !== '--out');
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const OUT = path.resolve(opt('out') ?? packet.out);
const only = new Set((opt('only') ?? 'model,docs,verify').split(','));
const sha256 = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const relTo = (from: string, to: string) => path.relative(from, to).split(path.sep).join('/') || '.';
const write = (f: string, data: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, typeof data === 'string' ? data : JSON.stringify(data));
  fs.renameSync(`${f}.tmp`, f);
};
const t0 = Date.now();
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- runs of another bundle
const linkRuns = opt('link-runs');
if (linkRuns) {
  for (const sub of ['runs', 'domains']) {
    const from = path.resolve(linkRuns, sub);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.join(OUT, sub), { recursive: true });
    for (const e of fs.readdirSync(from)) {
      const to = path.join(OUT, sub, e);
      if (!fs.existsSync(to)) fs.symlinkSync(path.join(from, e), to);
    }
  }
}

// ---------------------------------------------------------------- the input model
const modelFile = path.join(OUT, 'models', `${packet.domainId}.json`);
if (only.has('model')) {
  const tsx = path.join(dirs.explorer, 'node_modules/.bin/tsx');
  execFileSync(tsx, [path.join(dirs.builder, 'export-model.ts'), '--out', OUT, ...exportArgs], { cwd: dirs.explorer, stdio: ['ignore', 'inherit', 'inherit'] });
}
const model = fs.existsSync(modelFile) ? (JSON.parse(fs.readFileSync(modelFile, 'utf8')) as InputModel) : undefined;

// ---------------------------------------------------------------- docs (every docs/*.ts module: texts, docs, vocabulary; docs.ts)
const { docs, texts, vocabulary, modules: docModules } = await loadDocs();
const docFiles: Record<string, string> = {};
if (only.has('docs') || !fs.existsSync(path.join(OUT, 'docs'))) {
  fs.rmSync(path.join(OUT, 'docs'), { recursive: true, force: true });
  for (const [name, data] of Object.entries(docs)) write(path.join(OUT, 'docs', `${name}.json`), data);
}
for (const name of Object.keys(docs)) docFiles[name] = `docs/${name}.json`;

// ---------------------------------------------------------------- Verify
const commit = String(JSON.parse(fs.readFileSync(files.extraction, 'utf8')).meta?.commit ?? '');
let verify = null as Awaited<ReturnType<typeof buildVerify>>;
const verifyMeta = path.join(OUT, 'verify', 'build.json');
if (only.has('verify') && model) {
  verify = await buildVerify({ out: OUT, model });
  if (verify) write(verifyMeta, verify);
  else fs.rmSync(verifyMeta, { force: true });
} else if (fs.existsSync(verifyMeta)) verify = JSON.parse(fs.readFileSync(verifyMeta, 'utf8'));

// ---------------------------------------------------------------- the manifest
/** the metric docs' entries as the packet's measures (labels, units, directions, their doc) */
type DocEntry = { key: string; title: string; code?: string; kind: string; unit?: string; direction: string };
const metricDocs = (docs.metrics ?? []) as DocEntry[];
const measure = (d: DocEntry): MeasureDef => ({
  key: d.key, label: d.title, ...(d.code ? { code: d.code } : {}), ...(d.unit ? { unit: d.unit } : {}),
  direction: /violation/.test(d.direction) ? 'violation' : /minimi/.test(d.direction) ? 'minimize' : /higher/.test(d.direction) ? 'maximize' : 'descriptive',
});
const measures = (kind: string) => metricDocs.filter((d) => d.kind === kind).map(measure);

const domains = [...new Set([packet.domainId, ...(fs.existsSync(path.join(OUT, 'domains')) ? fs.readdirSync(path.join(OUT, 'domains')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [])])];
const modelTabs: ModelTabId[] = ['how', 'mech', 'domain', 'ops', 'workload', 'mm', ...(verify ? ['verify' as const] : [])];

// what the packet was built from: the input model's inputs, the Verify files' and the builder's own code
const input = (label: string, f: string): PacketInput => ({ label, root: 'project', path: rel(f), hash: sha256(f) });
const inputs: PacketInput[] = [
  ...(model?.inputs ?? []).filter((i) => i.hash).map((i) => ({ label: i.label, root: 'project', path: i.path, hash: i.hash! })),
  ...(verify?.inputs ?? []).map((f) => input('the Verify parts', f)),
  ...[path.join(dirs.builder, 'build.ts'), path.join(dirs.builder, 'config.ts'), path.join(dirs.builder, 'docs.ts'), ...docModules].map((f) => input('the packet builder', f)),
];
const seen = new Set<string>();
const uniqInputs = inputs.filter((i) => !seen.has(i.path) && !!seen.add(i.path));

const manifest: PacketManifest = {
  contract: CONTRACT_VERSION,
  id: packet.id,
  name: packet.name,
  description: packet.description,
  family: packet.family === FAMILY_PALLADIO ? FAMILY_PALLADIO : packet.family,
  domains,
  builtAt: new Date().toISOString(),
  builtBy: 'pnpm packet:misarch (cases/misarch/explorer-packet/build.ts)',
  fingerprint: crypto.createHash('sha256').update(uniqInputs.map((i) => `${i.path}:${i.hash}`).join('\n')).digest('hex').slice(0, 16),
  inputs: uniqInputs,
  // relative to the packet directory, so the packet moves with the repository
  roots: { project: relTo(OUT, dirs.project), explorer: relTo(OUT, dirs.explorer), case: relTo(OUT, dirs.case), core: relTo(OUT, dirs.core) },
  objectives: measures('objective'),
  constraints: measures('constraint'),
  metrics: measures('metric'),
  vocabulary,
  docs: docFiles,
  capabilities: { model: !!model, modelTabs, verify: !!verify, performance: true, simulate: true },
  sources: {
    misarch: { kind: 'git', label: sources.misarch.label, path: relTo(OUT, sources.misarch.dir), ref: verify?.commit ?? commit, about: sources.misarch.about },
    project: { kind: 'dir', label: sources.project.label, root: 'project', path: '.', allow: sources.project.allow, about: sources.project.about },
  },
  ...(verify ? { verify: verify.setup } : {}),
  commands: {
    // a design's detail (server/simulator.ts): rebuilt in its run's build and simulated with the search's request
    simulate: { argv: [relTo(dirs.case, files.designDetail), '{model}', '{diff}', '{out}', '{request}'], cwd: 'case', env: { DETAIL_BUILD: '{build}' }, about: "the design rebuilt in its run's build and simulated with the evaluation's request", timeoutS: 900 },
    // the packet again (server/model-sync.ts, when an input changed), with the input model's recorded export arguments
    rebuild: { argv: ['node_modules/.bin/tsx', relTo(dirs.explorer, path.join(dirs.builder, 'build.ts')), '--out', '{packet}', '--', '{exportArgs}'], cwd: 'explorer', about: 'pnpm packet:misarch', timeoutS: 1800 },
  },
};
write(path.join(OUT, 'packet.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`${path.join(OUT, 'packet.json')}: ${manifest.id} (${domains.join(', ')}), ${Object.keys(docFiles).length} docs (${Object.keys(texts).length} texts), verify ${verify ? 'yes' : 'no'}, ${uniqInputs.length} inputs, fingerprint ${manifest.fingerprint}; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
