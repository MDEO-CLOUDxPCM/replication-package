// Stage A of the headless harness: parse, link and validate the project's files with the real mdeo
// language services (no backend), and export what the optimizer and the plugin consume for one
// problem: MetamodelData, ModelData (one per model of that metamodel), transformation typed ASTs
// and script typed ASTs.
//
// usage: node export.mjs <project dir> <out dir> --metamodel <project path of the .mm>
//                        --optimize <project dir of the .mt/.fn, e.g. /optimize/generic>
//                        [--models a.m,b.m] [--contribution <plugin manifest json>]
//                        [--only mm|models|mt|fn]
//
// Virtual project layout (project-rooted paths, as the backend uses them): every file of
// metamodel/, models/ and optimize/ under its own path (/metamodel/architecture.mm, ...).
// Outputs:
//   <out>/metamodel.json (and every imported metamodel in <out>/metamodels/), <out>/<name>.model.json, <out>/transformations/<f>.json,
//   <out>/scripts/<f>.json
// A script that calls functions of a plugin (archSimulate, ...) only type-checks when the
// plugin's script contribution is known; pass its manifest (as `GET /` of the plugin service
// serves it) with --contribution. Without it such a script is reported and skipped.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const projectDir = args[0];
const outDir = args[1];
let manifestPath = null;
let only = null;
let metamodelPath = "/metamodel/architecture.mm";
let optimizeDir = "/optimize";
let modelFilter = null;
for (let i = 2; i < args.length; i++) {
    if (args[i] === "--contribution") manifestPath = args[++i];
    else if (args[i] === "--only") only = args[++i];
    else if (args[i] === "--metamodel") metamodelPath = args[++i];
    else if (args[i] === "--optimize") optimizeDir = args[++i].replace(/\/$/, "");
    else if (args[i] === "--models") modelFilter = args[++i].split(",");
}
const want = (k) => only == null || only === k;

const sc = await import("@mdeo/service-common");
sc.initializePluginContext();
const { URI } = await import("langium");
const { metamodelPluginProvider } = await import("@mdeo/language-metamodel");
const { modelPluginProvider } = await import("@mdeo/language-model");
const { modelTransformationPluginProvider } = await import("@mdeo/language-model-transformation");
const { scriptPluginProvider } = await import("@mdeo/language-script");
const svc = (p) => new URL(`../packages/${p}`, import.meta.url).href;
const { metamodelAstDataHandler } = await import(svc("service-metamodel/dist/handler/metamodelAstDataHandler.js"));
const { modelDataHandler } = await import(svc("service-model/dist/handler/modelDataHandler.js"));
const { typedAstHandler: mtTypedAstHandler } = await import(svc("service-model-transformation/dist/handler/typedAstHandler.js"));
const { typedAstHandler: fnTypedAstHandler } = await import(svc("service-script/dist/handler/typedAstHandler.js"));

// script contributions of plugins (only for scripts that call external functions)
let scriptContributions = [];
if (manifestPath) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const cp of manifest.contributionPlugins ?? []) {
        if (cp.languageId === "script") scriptContributions.push(...cp.serverContributionPlugins);
    }
}

const files = new Map();
function addTree(rel) {
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) addTree(r);
        else if (/\.(mm|m|mt|fn|config)$/.test(e.name)) files.set(r, readFileSync(join(projectDir, r), "utf8"));
    }
}
for (const dir of ["/metamodel", "/models", "/optimize", "/scripts", "/transform"]) addTree(dir);
if (!files.has(metamodelPath)) throw new Error(`no ${metamodelPath}`);
// the models of this metamodel (their `using` line names it)
const metamodelName = metamodelPath.slice(metamodelPath.lastIndexOf("/") + 1);
const models = [...files.keys()].filter((p) => p.startsWith("/models/") && p.endsWith(".m"))
    .filter((p) => new RegExp(`using\\s+"[^"]*/${metamodelName.replace(".", "\\.")}"`).test(files.get(p)))
    .map((p) => p.slice("/models/".length))
    .filter((f) => modelFilter == null || modelFilter.includes(f)).sort();
const inOptimize = (ext) => [...files.keys()].filter((p) => p.startsWith(optimizeDir + "/") && p.endsWith(ext)
    && !p.slice(optimizeDir.length + 1).includes("/")).map((p) => p.slice(optimizeDir.length + 1)).sort();
const transformations = inOptimize(".mt");
// the callees in subdirectories (e.g. /optimize/sync): validated, not exported (they are bundled
// into the typed AST of each transformation that calls them)
const callees = [...files.keys()].filter((p) => p.startsWith(optimizeDir + "/") && p.endsWith(".mt")
    && p.slice(optimizeDir.length + 1).includes("/")).sort();
const scripts = inOptimize(".fn");

const LANGS = {
    ".mm": [metamodelPluginProvider, "metamodel"],
    ".m": [modelPluginProvider, "model"],
    ".mt": [modelTransformationPluginProvider, "model-transformation"],
    ".fn": [scriptPluginProvider, "script"]
};

function newInstance(path, contributions = []) {
    const ext = path.slice(path.lastIndexOf("."));
    const [provider, languageId] = LANGS[ext];
    const pool = new sc.LangiumInstancePool({
        maxInstances: 1, languagePluginProvider: provider, serviceModule: undefined,
        languageId, extension: ext, backendUrl: "http://localhost:1"
    });
    return pool.createInstance(contributions, contributions.length ? "contrib" : "[]");
}

const astCache = new Map();
async function astOf(path) {
    if (!astCache.has(path)) astCache.set(path, (await run(sc.astHandler, path)).data);
    return structuredClone(astCache.get(path));
}

async function run(handler, path, contributions = []) {
    const instance = newInstance(path, contributions);
    const api = instance.services.shared.ServerApi;
    api.readFile = async (p) => {
        // as ServerApi.readFile: track the file (the AST handler serialises the files a document
        // imports, e.g. palladio.mm for architecture.mm, from the tracked ones)
        api.trackedFileDependencies.push({ path: p, version: 1 });
        return { content: files.get(p), version: 1 };
    };
    // as ServerApi.getFileData: cache the answer and record it as a dependency (remember), which
    // the AST handler needs for files imported by imported files (domain.mm → architecture.mm → palladio.mm)
    api.getFileData = async (p, key) => {
        if (key !== "ast") throw new Error(`unexpected file data ${key} for ${p}`);
        return api.remember(p, key, { data: await astOf(p), version: 1 });
    };
    const uri = URI.file(path);
    instance.services.shared.workspace.LangiumDocuments.createDocument(uri, files.get(path));
    const context = {
        fileInfo: { uri, version: 1 }, instance, services: instance.services, serverApi: api,
        contributionPlugins: contributions, signal: new AbortController().signal
    };
    const result = await handler(context);
    // the handler built the document: report its diagnostics
    const document = instance.services.shared.workspace.LangiumDocuments.getDocument(uri);
    const diagnostics = document ? sc.collectDiagnostics(document) : [];
    return { data: result.data, diagnostics };
}

mkdirSync(join(outDir, "transformations"), { recursive: true });
mkdirSync(join(outDir, "scripts"), { recursive: true });
let failed = false;
function report(path, diagnostics, data) {
    const errors = diagnostics.filter((d) => d.severity === 1);
    console.log(`${path}: ${errors.length} errors, ${diagnostics.length - errors.length} other diagnostics, data ${data == null ? "MISSING" : "ok"}`);
    for (const d of diagnostics) console.log(`   [${d.severity}] ${JSON.stringify(d.range?.start ?? d.line ?? "")} ${d.message}`);
    if (errors.length > 0 || data == null) failed = true;
    return errors.length === 0 && data != null;
}

if (want("mm") || want("models")) {
    // the metamodel and every file it imports (the backend merges them for an execution:
    // MetamodelData.load); metamodels/<path with / as __>.json, the main one also as metamodel.json
    mkdirSync(join(outDir, "metamodels"), { recursive: true });
    const pending = [metamodelPath];
    const done = new Set();
    while (pending.length > 0) {
        const path = pending.shift();
        if (done.has(path)) continue;
        done.add(path);
        const mm = await run(metamodelAstDataHandler, path);
        report(path, mm.diagnostics, mm.data);
        if (mm.data == null) continue;
        writeFileSync(join(outDir, "metamodels", path.replace(/^\//, "").replaceAll("/", "__") + ".json"), JSON.stringify(mm.data, null, 1));
        if (path === metamodelPath) writeFileSync(join(outDir, "metamodel.json"), JSON.stringify(mm.data, null, 1));
        pending.push(...(mm.data.importedMetamodelPaths ?? []));
    }
}

if (want("models")) {
    for (const f of models) {
        const path = `/models/${f}`;
        const model = await run(modelDataHandler, path);
        if (report(path, model.diagnostics, model.data)) {
            writeFileSync(join(outDir, f.replace(/\.m$/, ".model.json")), JSON.stringify(model.data, null, 1));
        }
    }
}

if (want("mt")) {
    for (const f of transformations) {
        const path = `${optimizeDir}/${f}`;
        const mt = await run(mtTypedAstHandler, path);
        if (report(path, mt.diagnostics, mt.data)) {
            writeFileSync(join(outDir, "transformations", f + ".json"), JSON.stringify(mt.data, null, 1));
        }
    }
    for (const path of callees) {
        const mt = await run(mtTypedAstHandler, path);
        report(path, mt.diagnostics, mt.data);
    }
}

if (want("fn")) {
    if (scriptContributions.length > 0) {
        // the contributed functions as the backend serves them to executions
        // (projects/{id}/file-data/typed-ast?language=script: typedAstHandler without a file)
        const instance = newInstance("/plugin.fn", scriptContributions);
        const root = await fnTypedAstHandler({ fileInfo: undefined, instance, services: instance.services,
            serverApi: instance.services.shared.ServerApi, contributionPlugins: scriptContributions,
            signal: new AbortController().signal });
        writeFileSync(join(outDir, "scripts", "plugin-ast.json"), JSON.stringify(root.data, null, 1));
        console.log(`plugin AST: ${root.data.functions.map((f) => f.name).join(", ")}`);
    }
    for (const f of scripts) {
        const path = `${optimizeDir}/${f}`;
        const text = files.get(path);
        const external = /\b(arch|pcm)[A-Z][A-Za-z]*\s*\(/.test(text);
        if (external && scriptContributions.length === 0) {
            console.log(`${path}: SKIPPED (calls plugin functions; pass --contribution <manifest.json>)`);
            continue;
        }
        const fn = await run(fnTypedAstHandler, path, external ? scriptContributions : []);
        if (report(path, fn.diagnostics, fn.data)) {
            writeFileSync(join(outDir, "scripts", f + ".json"), JSON.stringify(fn.data, null, 1));
        }
    }
}

console.log(failed ? "VALIDATION FAILED" : "ALL FILES PARSED AND VALIDATED");
process.exit(failed ? 1 : 0);
