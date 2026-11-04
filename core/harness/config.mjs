// Validates a .config file with the real config-optimization and config-mdeo languages (each
// parses its own sections, as the config service splits them) and derives the OptimizationConfig
// JSON the way mdeoExecutionRequestHandler does.
//
// usage: node config.mjs <project dir> <config path, e.g. optimize/domain/today-3obj-5sim.config> <out json>
//                        [--population N] [--evolutions N] [--batches N] [--model <project path>]
//                        [--contribution <plugin manifest json>]
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, posix } from "node:path";

const argv = process.argv.slice(2);
const [projectDir, configRel, outFile] = argv;
const opts = {};
for (let i = 3; i < argv.length; i += 2) opts[argv[i].replace(/^--/, "")] = argv[i + 1];

const sc = await import("@mdeo/service-common");
sc.initializePluginContext();
const { URI } = await import("langium");
const { metamodelPluginProvider } = await import("@mdeo/language-metamodel");
const { scriptPluginProvider } = await import("@mdeo/language-script");
const { modelPluginProvider } = await import("@mdeo/language-model");
const { modelTransformationPluginProvider } = await import("@mdeo/language-model-transformation");
const { configOptimizationPluginProvider } = await import("@mdeo/language-config-optimization");
const { configMdeoPluginProvider } = await import("@mdeo/language-config-mdeo");
const svc = (p) => new URL(`../packages/${p}`, import.meta.url).href;
const opt = await import(svc("service-config-optimization/dist/handler/optimizationRequestHandler.js"));
const mdeo = await import(svc("service-config-mdeo/dist/handler/mdeoRequestHandler.js"));
const { ServiceMdeoMetamodelResolver } = await import(svc("service-config-mdeo/dist/serviceMdeoMetamodelResolver.js"));

let scriptContributions = [];
if (opts.contribution) {
    const manifest = JSON.parse(readFileSync(opts.contribution, "utf8"));
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
const configPath = "/" + configRel.replace(/^\//, "");
let configText = files.get(configPath);
if (configText == null) throw new Error(`no ${configPath}`);
if (opts.model) {
    // run the same config from another seed: replace the problem's model path
    const rel = posix.relative(posix.dirname(configPath), "/" + opts.model.replace(/^\//, ""));
    configText = configText.replace(/\bmodel\s*=\s*"[^"]*"/, `model = "${rel}"`);
}

function instance(provider, languageId, extension, serviceModule, contributions = []) {
    const pool = new sc.LangiumInstancePool({
        maxInstances: 1, languagePluginProvider: provider, serviceModule, languageId, extension,
        backendUrl: "http://localhost:1"
    });
    return pool.createInstance(contributions, contributions.length ? "contrib" : "[]");
}
const LANGS = { ".mm": [metamodelPluginProvider, "metamodel"], ".fn": [scriptPluginProvider, "script"],
    ".m": [modelPluginProvider, "model"], ".mt": [modelTransformationPluginProvider, "model-transformation"] };
const astCache = new Map();
async function astOf(path) {
    if (!astCache.has(path)) {
        const ext = path.slice(path.lastIndexOf("."));
        const inst = instance(LANGS[ext][0], LANGS[ext][1], ext, undefined, ext === ".fn" ? scriptContributions : []);
        patch(inst);
        const uri = URI.file(path);
        inst.services.shared.workspace.LangiumDocuments.createDocument(uri, files.get(path));
        const r = await sc.astHandler({ fileInfo: { uri, version: 1 }, instance: inst, services: inst.services,
            serverApi: inst.services.shared.ServerApi, contributionPlugins: ext === ".fn" ? scriptContributions : [],
            signal: new AbortController().signal });
        astCache.set(path, r.data);
    }
    return structuredClone(astCache.get(path));
}
function patch(inst) {
    const api = inst.services.shared.ServerApi;
    api.readFile = async (p) => {
        // as ServerApi.readFile: track the file (the AST handler serialises the files a document
        // imports, e.g. palladio.mm for architecture.mm, from the tracked ones)
        api.trackedFileDependencies.push({ path: p, version: 1 });
        return { content: files.get(p), version: 1 };
    };
    // as ServerApi.getFileData: cache the answer and record it as a dependency (see export.mjs)
    api.getFileData = async (p, key) => {
        if (key !== "ast") throw new Error(`unexpected ${key} ${p}`);
        return api.remember(p, key, { data: await astOf(p), version: 1 });
    };
    return api;
}

// split the config into its top-level sections
function sections(text) {
    const result = {};
    const re = /^(\w+)\s*\{/gm;
    let m;
    while ((m = re.exec(text))) {
        let depth = 0, i = m.index + m[0].length - 1;
        for (; i < text.length; i++) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}" && --depth === 0) break;
        }
        result[m[1]] = text.slice(m.index, i + 1);
        re.lastIndex = i + 1;
    }
    return result;
}
const parts = sections(configText);
const configFileUri = URI.file(configPath).toString();

async function request(inst, handler, body) {
    return handler({ body, instance: inst, services: inst.services, serverApi: patch(inst), jwt: "", contributionPlugins: [] });
}

let failed = false;
function report(name, diagnostics) {
    const errors = diagnostics.diagnostics.filter((d) => d.severity === 1);
    console.log(`${name}: ${errors.length} errors, ${diagnostics.diagnostics.length - errors.length} other diagnostics` +
        (diagnostics.dependenciesWithErrors.length ? `, dependencies with errors ${diagnostics.dependenciesWithErrors}` : ""));
    for (const d of diagnostics.diagnostics) console.log(`   [${d.severity}] ${JSON.stringify(d.range?.start)} ${d.message}`);
    if (errors.length) failed = true;
}

const optText = [parts.problem, parts.goal].join("\n\n");
const optBody = { text: optText, configFileUri, dependencyData: {} };
report(`${configPath}: problem + goal (config-optimization)`,
    await request(instance(configOptimizationPluginProvider, "config-optimization", ".config"), opt.optimizationDiagnosticsRequestHandler, optBody));
const optData = (await request(instance(configOptimizationPluginProvider, "config-optimization", ".config"), opt.optimizationRequestHandler, optBody)).data;

const mdeoText = [parts.search, parts.solver, parts.runtime].filter((s) => s).join("\n\n");
const mdeoBody = { text: mdeoText, configFileUri, dependencyData: { optimization: { problem: optData?.problem } } };
const mdeoModule = { MdeoMetamodelResolver: () => new ServiceMdeoMetamodelResolver() };
report(`${configPath}: search + solver + runtime (config-mdeo)`,
    await request(instance(configMdeoPluginProvider, "config-mdeo", ".config", mdeoModule), mdeo.mdeoDiagnosticsRequestHandler, mdeoBody));
const mdeoData = (await request(instance(configMdeoPluginProvider, "config-mdeo", ".config", mdeoModule), mdeo.mdeoRequestHandler, mdeoBody)).data;

if (failed || optData == null || mdeoData == null) {
    console.log("CONFIG VALIDATION FAILED");
    process.exit(1);
}

// as mdeoExecutionRequestHandler: search.mutations {operators [{path, arguments}], generate} and
// search.crossovers {operators} (mdeo main a38b7be3 and later)
const { buildSearchConfig } = await import(svc("service-config-mdeo/dist/handler/mdeoExecutionRequestHandler.js"));
const config = {
    problem: optData.problem,
    goal: optData.goal,
    search: buildSearchConfig(mdeoData.search),
    solver: mdeoData.solver,
    runtime: mdeoData.runtime
};
if (opts.population) config.solver.parameters.population = Number(opts.population);
if (opts.evolutions) config.solver.termination.evolutions = Number(opts.evolutions);
if (opts.batches) config.solver.batches = Number(opts.batches);
writeFileSync(outFile, JSON.stringify(config, null, 2));
console.log(`CONFIG VALIDATED; OptimizationConfig written to ${outFile}`);
