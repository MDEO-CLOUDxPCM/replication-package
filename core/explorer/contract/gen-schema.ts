/**
 * Writes the JSON schemas (pnpm contract:schema):
 *   contract/schema/explorer-contract.schema.json   every type of contract/types.ts
 *   contract/schema/packet.schema.json              packet.json (contract/packet.ts PacketManifest; docs/packet-format.md)
 *   contract/schema/verify.schema.json              a packet's verify/*.json (contract/verify.ts)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';
import { CONTRACT_VERSION } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tsconfig = path.join(HERE, '..', 'tsconfig.json');
const outDir = path.join(HERE, 'schema');
fs.mkdirSync(outDir, { recursive: true });

function emit(file: string, source: string, type: string, title: string, id: string) {
  const schema = createGenerator({ path: path.join(HERE, source), tsconfig, type, expose: 'export', topRef: true, jsDoc: 'extended', skipTypeCheck: true }).createSchema(type);
  schema.$id = `https://local/${id}/${CONTRACT_VERSION}`;
  (schema as Record<string, unknown>).title = `${title} ${CONTRACT_VERSION}`;
  const out = path.join(outDir, file);
  fs.writeFileSync(out, JSON.stringify(schema, null, 1) + '\n');
  console.log(out, Object.keys(schema.definitions ?? {}).length, 'definitions');
}

emit('explorer-contract.schema.json', 'types.ts', '*', 'Explorer data contract', 'explorer-contract');
emit('packet.schema.json', 'packet.ts', 'PacketManifest', 'Explorer data packet manifest (packet.json)', 'explorer-packet');
emit('verify.schema.json', 'verify.ts', '*', 'Explorer data packet Verify files', 'explorer-verify');
