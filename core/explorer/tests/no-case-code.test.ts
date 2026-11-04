/**
 * The lint against case code in the generic explorer (docs/packet-format.md): what belongs to a case comes in its packet,
 * so the generic code — web/src (not components/ui), server/, contract/, layout/, sources/, dummy/ — must not
 *
 *   (a) name the case anywhere, comments included (case-insensitive): CASE_WORDS;
 *   (b) show the case in a user-visible string (string literals, template literal text, JSX text and JSX string
 *       attributes; parsed with the TypeScript compiler; module specifiers and literal types are no text):
 *       citation ids (`§<letter>…`, `AB<n>`, `AA<n>`), `package A` / `package C`, the case
 *       project's paths (domain/…, workload/…, timing/…, tools/…, transform/…, optimize/…, metamodel/…,
 *       models/domain-…, palladio-sim-service; URLs and model targets like `mm:domain/X` are left out), the case domain's class names (compound
 *       CamelCase names, and `Class.field` of any of its classes; the list is no-case-code.names.json);
 *   (c) import the case (cases/<case>/, e.g. its packet builder cases/<case>/explorer-packet/).
 *
 * The exceptions are in no-case-code.allow.json (file, rule, match, count: robust to line moves; `why`): only what
 * matches a rule without being the case (the source viewer's Kotlin grammar, the family's simulator plugin). A file
 * may have at most `count` violations of a (rule, match), so a new one fails. Entries no longer needed fail with
 * LINT_STRICT=1. `LINT_WRITE=1` rewrites the allowlist from the current violations (then add the `why` again).
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ALLOW_FILE = path.join(__dirname, 'no-case-code.allow.json');
const NAMES_FILE = path.join(__dirname, 'no-case-code.names.json');
/** the case domain's class names; checked against the built packet's domain when that exists (below) */
const NAMES = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')) as { about: string; sources: string[]; classes: string[] };
const CASE_DOMAINS = NAMES.sources.map((s) => path.resolve(ROOT, '../..', s)).filter((f) => fs.existsSync(f));

export type Rule = 'case-name' | 'citation-id' | 'package' | 'case-path' | 'case-class' | 'import-case';
export interface Violation { file: string; rule: Rule; match: string; line: number }
/** `why`: a permanent exception says why it is not the case (a syntax grammar, the family's simulator) */
interface AllowEntry { file: string; rule: Rule; match: string; count: number; why?: string }

// ---------------------------------------------------------------- the rules

const CASE_WORDS = /misarch|kotlin|keycloak|\bdapr|gatling|\bround[ -]?2\b/gi;
const CITATION_ID = /§\s?[A-Z]+[\d.]*|\bA[AB]\d+(?:\.\d+)*/g;
const PACKAGE = /\bpackage [AC]\b/g;
const CASE_PATH = /(?<![\w.:-])(?:\.\.\/)*(?:(?:cases|domain|workload|timing|tools|transform|optimize|metamodel)\/[\w.*<>{}-]+|models\/domain-[\w.*-]*)|palladio-sim-service/g;
const URL = /\bhttps?:\/\/\S+/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compound = NAMES.classes.filter((c) => /^[A-Z][a-z0-9]+[A-Z]/.test(c));
const CASE_CLASS = new RegExp(`\\b(?:${NAMES.classes.map(esc).join('|')})\\.[a-z]\\w*|\\b(?:${compound.map(esc).join('|')})\\b`, 'g');

const matches = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => ({ text: m[0], at: m.index! }));

// ---------------------------------------------------------------- the files

const SCAN: { dir: string; ext: RegExp; skip?: RegExp }[] = [
  { dir: 'web/src', ext: /\.(ts|tsx|css)$/, skip: /^web\/src\/components\/ui\// },
  { dir: 'server', ext: /\.(ts|py)$/ },
  { dir: 'contract', ext: /\.ts$/ },
  { dir: 'layout', ext: /\.ts$/ },
  { dir: 'sources', ext: /\.ts$/ },
  { dir: 'dummy', ext: /\.ts$/ },
];

function files(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  for (const s of SCAN) {
    const before = out.length;
    walk(s.dir);
    out.splice(before, out.length - before, ...out.slice(before).filter((f) => s.ext.test(f) && !s.skip?.test(f)));
  }
  return out.sort();
}

/** the user-visible strings of a TS/TSX source (with their offsets) and its module specifiers */
function strings(file: string, text: string): { texts: { text: string; at: number }[]; imports: { spec: string; at: number }[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const texts: { text: string; at: number }[] = [];
  const imports: { spec: string; at: number }[] = [];
  const isModuleSpec = (n: ts.Node) => {
    const p = n.parent;
    if (!p) return false;
    if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === n) return true;
    if (ts.isExternalModuleReference(p)) return true;
    if (ts.isLiteralTypeNode(p) && p.parent && ts.isImportTypeNode(p.parent)) return true;
    if (ts.isCallExpression(p) && p.arguments[0] === n && (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === 'require'))) return true;
    if (ts.isModuleDeclaration(p) && p.name === n) return true;
    return false;
  };
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (isModuleSpec(n)) imports.push({ spec: n.text, at: n.getStart(sf) });
      else if (!(n.parent && ts.isLiteralTypeNode(n.parent))) texts.push({ text: n.text, at: n.getStart(sf) });
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      texts.push({ text: n.text, at: n.getStart(sf) });
    } else if (ts.isJsxText(n)) {
      if (n.text.trim()) texts.push({ text: n.text, at: n.getStart(sf) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { texts, imports };
}

export function lint(rel: string, text: string): Violation[] {
  const out: Violation[] = [];
  const lineAt = (at: number) => text.slice(0, at).split('\n').length;
  const add = (rule: Rule, match: string, at: number) => out.push({ file: rel, rule, match, line: lineAt(at) });
  // (a) anywhere
  for (const m of matches(CASE_WORDS, text)) add('case-name', m.text.toLowerCase(), m.at);
  if (/\.tsx?$/.test(rel)) {
    const { texts, imports } = strings(rel, text);
    // (b) user-visible strings
    for (const s of texts) {
      for (const m of matches(CITATION_ID, s.text)) add('citation-id', m.text, s.at);
      for (const m of matches(PACKAGE, s.text)) add('package', m.text, s.at);
      for (const m of matches(CASE_PATH, s.text.replace(URL, ' '))) add('case-path', m.text, s.at);
      for (const m of matches(CASE_CLASS, s.text)) add('case-class', m.text, s.at);
    }
    // (c) imports of the case
    for (const i of imports) {
      if (!i.spec.startsWith('.')) continue;
      const target = path.relative(path.resolve(ROOT, '../..'), path.resolve(ROOT, path.dirname(rel), i.spec)).split(path.sep).join('/');
      if (target === 'cases' || target.startsWith('cases/')) add('import-case', i.spec, i.at);
    }
  } else if (rel.endsWith('.py')) {
    for (const m of matches(/^\s*(?:from|import)\s+\S*\bcases\b.*$/gm, text)) add('import-case', m.text.trim(), m.at);
  }
  return out;
}

const keyOf = (v: { file: string; rule: string; match: string }) => `${v.file}\u0000${v.rule}\u0000${v.match}`;

function current(): Violation[] {
  return files().flatMap((f) => lint(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
}

function group(vs: Violation[]): Map<string, { entry: AllowEntry; lines: number[] }> {
  const g = new Map<string, { entry: AllowEntry; lines: number[] }>();
  for (const v of vs) {
    const k = keyOf(v);
    const e = g.get(k) ?? { entry: { file: v.file, rule: v.rule, match: v.match, count: 0 }, lines: [] };
    e.entry.count++;
    e.lines.push(v.line);
    g.set(k, e);
  }
  return g;
}

// ---------------------------------------------------------------- the tests

describe('no case code in the generic explorer', () => {
  it('the rules: what they catch and what they leave', () => {
    const v = (f: string, t: string) => lint(f, t).map((x) => `${x.rule}:${x.match}`);
    // (a) anywhere, comments included
    expect(v('web/src/x.ts', '// the MiSArch case\nconst a = 1; /* misarch-kotlin */')).toEqual(['case-name:misarch', 'case-name:misarch', 'case-name:kotlin']);
    expect(v('server/x.py', '# keycloak and Dapr, Gatling in round 2\n')).toEqual(['case-name:keycloak', 'case-name:dapr', 'case-name:gatling', 'case-name:round 2']);
    expect(v('web/src/x.css', '.a { color: red } /* round-2 */')).toEqual(['case-name:round-2']);
    expect(v('web/src/x.ts', 'const adaptive = "around 20 rounds"; // roundtrip 25')).toEqual([]);
    // (b) only in user-visible strings
    expect(v('web/src/x.tsx', `
      // §AB37, AB38 and domain/x.json in a comment are fine
      import { a } from './domain/a';
      type K = '§AB1';
      const s = 'see §AB37.2 and (AB38), §AA, F2';
      const t = \`package C's \${a} in domain/misarch-domain.json\`;
      const u = <p title="models/domain-neutral.m">see ../palladio-sim-service and Product.categories of an OrderItem</p>;
      const w = 'https://example.org/tools/x and /api/domains/x and mm:domain/Process and explorer/tools/shots.ts';
    `)).toEqual([
      'case-name:misarch',
      'citation-id:§AB37.2', 'citation-id:AB38', 'citation-id:§AA',
      'package:package C', 'case-path:domain/misarch-domain.json',
      'case-path:models/domain-neutral.m',
      'case-path:palladio-sim-service', 'case-class:Product.categories', 'case-class:OrderItem',
      'case-path:tools/shots.ts',
    ]);
    expect(v('web/src/x.ts', 'const o = { domains: "domains/<id>.json", text: "a Product or an Order", f: "Order.status" };')).toEqual(['case-class:Order.status']);
    // (c) imports of the case
    expect(v('web/src/lib/x.ts', "import { a } from '../../../../../cases/misarch/explorer-packet/config';\nconst b = await import('../../../../../cases/x');\nimport { c } from './cases';"))
      .toEqual(['case-name:misarch', 'import-case:../../../../../cases/misarch/explorer-packet/config', 'import-case:../../../../../cases/x']);
    expect(v('server/x.ts', "import { a } from '../../../cases/misarch/explorer-packet/build';")).toEqual(['case-name:misarch', 'import-case:../../../cases/misarch/explorer-packet/build']);
    expect(v('server/x.py', 'from cases.misarch import x\nimport os\n')).toEqual(['case-name:misarch', 'import-case:from cases.misarch import x']);
  });

  it('no violation beyond the allowlist', () => {
    const now = group(current());
    if (process.env.LINT_WRITE === '1') {
      const entries = [...now.values()].map((x) => x.entry).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
      fs.writeFileSync(ALLOW_FILE, JSON.stringify(entries, null, 1) + '\n');
    }
    const allow = new Map((JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) as AllowEntry[]).map((e) => [keyOf(e), e]));
    const over = [...now.values()]
      .filter(({ entry }) => entry.count > (allow.get(keyOf(entry))?.count ?? 0))
      .map(({ entry, lines }) => `${entry.file}:${lines.join(',')} ${entry.rule} "${entry.match}" (${entry.count}, allowed ${allow.get(keyOf(entry))?.count ?? 0})`);
    expect(over, 'case code in the generic explorer (move it into the packet; tests/no-case-code.test.ts)').toEqual([]);
  });

  it.skipIf(process.env.LINT_STRICT !== '1')('no stale allowlist entries (LINT_STRICT=1)', () => {
    const now = group(current());
    const allow = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) as AllowEntry[];
    const stale = allow.filter((e) => (now.get(keyOf(e))?.entry.count ?? 0) < e.count).map((e) => `${e.file} ${e.rule} "${e.match}" (${now.get(keyOf(e))?.entry.count ?? 0} of ${e.count})`);
    expect(stale).toEqual([]);
  });

  it.skipIf(!CASE_DOMAINS.length)('the class names cover the case domain\'s classes', () => {
    for (const f of CASE_DOMAINS) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8')) as { classes: { id: string; name: string }[] };
      expect(d.classes.flatMap((c) => [c.id, c.name]).filter((c) => !NAMES.classes.includes(c)), f).toEqual([]);
    }
  });
});
