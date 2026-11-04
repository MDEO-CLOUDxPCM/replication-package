/** Validation of contract documents against the generated JSON schema (ajv). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(HERE, 'schema', 'explorer-contract.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
ajv.addSchema(schema, 'contract');
// (1.10.0) a packet's manifest and its Verify files
ajv.addSchema(JSON.parse(fs.readFileSync(path.join(HERE, 'schema', 'packet.schema.json'), 'utf8')), 'packet');
ajv.addSchema(JSON.parse(fs.readFileSync(path.join(HERE, 'schema', 'verify.schema.json'), 'utf8')), 'verify');

/** packet.json (contract/packet.ts PacketManifest) */
export function validateManifest(doc: unknown): string[] {
  const v = ajv.getSchema('packet')!;
  return v(doc) ? [] : (v.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** a Verify file of a packet (contract/verify.ts) */
export function validateVerify(type: 'VerifyParts' | 'VerifyCauses' | 'VerifyChains', doc: unknown): string[] {
  const v = ajv.getSchema(`verify#/definitions/${type}`);
  if (!v) throw new Error(`no schema for ${type}`);
  return v(doc) ? [] : (v.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

export type ContractType = 'Run' | 'DesignList' | 'DesignFile' | 'DesignStreamHeader' | 'Design' | 'Domain' | 'DesignDetail' | 'RunIndex' | 'InputModel';

/** the first `n` lines of a jsonl file (reads only as much of the file as needed) */
function headLines(file: string, n: number): unknown[] {
  const fd = fs.openSync(file, 'r');
  try {
    const out: unknown[] = [];
    const chunk = Buffer.allocUnsafe(1 << 20);
    let rest = '';
    let pos = 0;
    while (out.length < n) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, pos);
      pos += read;
      const text = rest + chunk.toString('utf8', 0, read);
      const lines = text.split('\n');
      rest = read ? lines.pop()! : '';
      for (const l of lines) if (l.trim() && out.length < n) out.push(JSON.parse(l));
      if (!read) break;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

export function validate(type: ContractType, doc: unknown): string[] {
  const v = ajv.getSchema(`contract#/definitions/${type}`);
  if (!v) throw new Error(`no schema for ${type}`);
  return v(doc) ? [] : (v.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** validate a bundle or packet directory (CLI: tsx contract/validate.ts <dir>): its packet.json and Verify files too */
export function validateBundle(root: string): string[] {
  const errs: string[] = [];
  const manifest = path.join(root, 'packet.json');
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const e of validateManifest(m)) errs.push(`packet.json: ${e}`);
    for (const [name, type] of [['parts', 'VerifyParts'], ['causes', 'VerifyCauses'], ['chains', 'VerifyChains']] as const) {
      const f = m.verify?.[name] ? path.join(root, m.verify[name]) : '';
      if (f && fs.existsSync(f)) for (const e of validateVerify(type, JSON.parse(fs.readFileSync(f, 'utf8')))) errs.push(`${m.verify[name]}: ${e}`);
    }
  }
  const check = (type: ContractType, file: string, pick?: (d: any) => unknown) => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of validate(type, pick ? pick(doc) : doc)) errs.push(`${path.relative(root, file)}: ${e}`);
  };
  const domains = path.join(root, 'domains');
  for (const f of fs.existsSync(domains) ? fs.readdirSync(domains) : []) check('Domain', path.join(domains, f));
  const models = path.join(root, 'models');
  if (fs.existsSync(models)) for (const f of fs.readdirSync(models).filter((x) => x.endsWith('.json'))) check('InputModel', path.join(models, f));
  const runs = path.join(root, 'runs');
  for (const r of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
    const dir = path.join(root, 'runs', r);
    check('Run', path.join(dir, 'run.json'));
    const jsonl = path.join(dir, 'designs.jsonl');
    let sample: any[];
    if (fs.existsSync(jsonl)) {
      const [header, ...rest] = headLines(jsonl, 51) as any[];
      for (const e of validate('DesignStreamHeader', header)) errs.push(`${r}/designs.jsonl header: ${e}`);
      sample = rest;
    } else {
      check('DesignFile', path.join(dir, 'designs.json'), (d) => ({ ...d, designs: d.designs.slice(0, 200) }));
      sample = JSON.parse(fs.readFileSync(path.join(dir, 'designs.json'), 'utf8')).designs.slice(0, 50);
    }
    for (const d of sample) for (const e of validate('Design', d)) errs.push(`${r}/designs ${d.id}: ${e}`);
    const det = path.join(dir, 'details');
    if (fs.existsSync(det)) for (const f of fs.readdirSync(det).slice(0, 5)) check('DesignDetail', path.join(det, f));
  }
  return errs;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.argv[2]) { console.error('usage: tsx contract/validate.ts <bundle or packet directory>'); process.exit(2); }
  const errs = validateBundle(path.resolve(process.argv[2]));
  console.log(errs.length ? errs.join('\n') : 'bundle valid');
  process.exit(errs.length ? 1 : 0);
}
