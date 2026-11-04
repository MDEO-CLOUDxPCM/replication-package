/**
 * The Verify tab's files of the MiSArch packet (verify/parts.json, causes.json, chains.json; contract/verify.ts):
 * precomputed from package A's extraction, misarch-kotlin's inventory, package C's workload, misarch-kotlin's files at
 * the extraction's commit and the input model, so the explorer's Verify tab is a generic viewer of claims and their
 * evidence. Called by build.ts; every path comes from config.ts.
 *
 *   parts.json    the parts (parts.ts and its builders) with the case's kinds, groups, scopes and document kinds
 *   causes.json   per operation of the model what it causes (causes.ts), by its part's key
 *   chains.json   per operation the code from its entry to its steps (chains.py on cases/misarch/extract/callgraph.py)
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, type InputModel } from '../../../../core/explorer/contract/types';
import type { VerifySetup } from '../../../../core/explorer/contract/packet';
import type { VerifyCauses, VerifyParts } from '../../../../core/explorer/contract/verify';
import { files, sources } from '../config';
import { buildCauses } from './causes';
import { DOC_KINDS, LATE_GROUPS, LEAD_FACTS, OP_SCOPE, PART_KINDS, TREE, type Workload } from './claims';
import type { Extraction, Inventory } from './extraction';
import { buildParts } from './parts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface VerifyBuild {
  /** the files written, relative to the packet (packet.json `verify`) */
  setup: VerifySetup;
  /** the commit of misarch-kotlin the evidence points at (the `misarch` source tree's ref) */
  commit: string;
  /** the files read (for the packet's inputs) */
  inputs: string[];
}

const readJson = <T>(f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as T;
const write = (f: string, body: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, body);
  fs.renameSync(`${f}.tmp`, f);
};

/** the files of misarch-kotlin at a commit */
export function gitTree(dir: string, commit: string): Set<string> {
  try { return new Set(execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', commit], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean)); }
  catch { throw new Error(`misarch-kotlin at ${dir} has no commit ${commit.slice(0, 12)} (MISARCH_KOTLIN)`); }
}

/** per operation the code contributing its steps (chains.py), as the JSON it prints */
export function runChains(commit: string): Promise<string> {
  const env = { ...process.env, MISARCH_REF: commit, MISARCH_KOTLIN: sources.misarch.dir };
  return new Promise<string>((ok, fail) => execFile('python3', [path.join(HERE, 'chains.py'), files.extraction, files.callgraph], { env, maxBuffer: 256 << 20 },
    (e, out, err) => (e ? fail(new Error(`chains.py: ${err.trim().split('\n').pop() ?? e.message}`)) : ok(out))));
}

/** the parts and causes of the model, in memory (also for the case's tests) */
export function computeVerify(model: InputModel | undefined, tree: Set<string> | undefined) {
  const a = readJson<Extraction>(files.extraction);
  const inventory = readJson<Inventory>(files.inventory);
  const workload = readJson<Workload>(files.workload);
  const parts = buildParts({ a, model, tree, inventory, workload });
  const causes: VerifyCauses = {};
  if (model) {
    const mops = new Map(model.operations.map((o) => [o.id, o]));
    for (const o of a.operations) { const mo = mops.get(o.id); if (mo) causes[`op:${o.id}`] = buildCauses(a, model, o, mo); }
  }
  const body: VerifyParts = {
    contract: CONTRACT_VERSION, tree: TREE, commit: a.meta.commit,
    kinds: PART_KINDS, lateGroups: LATE_GROUPS, scopes: OP_SCOPE, docKinds: DOC_KINDS, leadFacts: LEAD_FACTS, parts,
  };
  return { a, parts: body, causes };
}

/** writes <out>/verify/*.json; null without an extraction (the packet then has no Verify tab) */
export async function buildVerify({ out, model }: { out: string; model: InputModel }): Promise<VerifyBuild | null> {
  if (!fs.existsSync(files.extraction)) return null;
  const t0 = Date.now();
  const commit = String(readJson<Extraction>(files.extraction).meta?.commit ?? '');
  if (!commit) throw new Error(`${files.extraction} names no commit (meta.commit)`);
  const chains = runChains(commit);
  const tree = gitTree(sources.misarch.dir, commit);
  const { parts, causes } = computeVerify(model, tree);
  const setup: VerifySetup = { parts: 'verify/parts.json', causes: 'verify/causes.json', chains: 'verify/chains.json' };
  write(path.join(out, setup.parts), JSON.stringify(parts));
  write(path.join(out, setup.causes!), JSON.stringify(causes));
  write(path.join(out, setup.chains!), await chains);
  console.log(`verify: ${parts.parts.length} parts, ${Object.keys(causes).length} operations' causes, chains; misarch-kotlin@${commit.slice(0, 12)}; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const own = fs.readdirSync(HERE).filter((f) => /\.(ts|py)$/.test(f)).sort().map((f) => path.join(HERE, f));
  const extract = path.dirname(files.callgraph);
  return {
    setup, commit,
    inputs: [files.extraction, files.inventory, files.workload, files.callgraph, path.join(extract, 'gitsrc.py'), path.join(extract, 'kt.py'), ...own].filter((f) => fs.existsSync(f)),
  };
}
