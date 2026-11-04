package com.mdeo.optimizer

import com.mdeo.expression.ast.expressions.TypedExpression
import com.mdeo.expression.ast.statements.TypedStatement
import com.mdeo.metamodel.Metamodel
import com.mdeo.metamodel.data.MetamodelData
import com.mdeo.metamodel.data.load
import com.mdeo.metamodel.data.ModelData
import com.mdeo.modeltransformation.ast.TransformationOperator
import com.mdeo.modeltransformation.ast.TypedAst as TransformationTypedAst
import com.mdeo.modeltransformation.ast.expressions.TypedExpressionSerializer as TransformationExpressionSerializer
import com.mdeo.modeltransformation.ast.patterns.TypedPatternElement
import com.mdeo.modeltransformation.ast.patterns.TypedPatternElementSerializer
import com.mdeo.modeltransformation.ast.statements.TypedTransformationStatement
import com.mdeo.modeltransformation.ast.statements.TypedTransformationStatementSerializer
import com.mdeo.modeltransformation.graph.mdeo.MdeoModelGraph
import com.mdeo.modeltransformation.runtime.TransformationEngine
import com.mdeo.modeltransformation.runtime.TransformationExecutionResult
import com.mdeo.optimizer.config.ConfigLiteral
import com.mdeo.optimizer.config.MutationStepConfig
import com.mdeo.optimizer.config.OperatorRef
import com.mdeo.optimizer.config.VariationType
import com.mdeo.optimizer.config.ObjectiveTendency
import com.mdeo.optimizer.config.OptimizationConfig
import com.mdeo.optimizer.evaluation.LocalMutationEvaluator
import com.mdeo.optimizer.evaluation.MutationEvaluator
import com.mdeo.optimizer.evaluation.WorkerSolutionRef
import com.mdeo.optimizer.guidance.ScriptGuidanceFunction
import com.mdeo.optimizer.moea.getWorkerRef
import com.mdeo.optimizer.operators.CrossoverOperator
import com.mdeo.optimizer.operators.CrossoverStrategyFactory
import com.mdeo.optimizer.operators.MutationStrategyFactory
import com.mdeo.optimizer.operators.OperatorCatalog
import com.mdeo.optimizer.operators.TransformationAttemptRunner
import com.mdeo.optimizer.rulegen.MetamodelInfo
import com.mdeo.optimizer.rulegen.MultiplicityChecker
import com.mdeo.optimizer.rulegen.MutationRuleGenerator
import com.mdeo.optimizer.rulegen.Preparation
import com.mdeo.optimizer.solution.Solution
import com.mdeo.script.ast.TypedAst as ScriptTypedAst
import com.mdeo.script.ast.TypedPluginAst
import com.mdeo.script.ast.expressions.TypedExpressionSerializer as ScriptExpressionSerializer
import com.mdeo.script.ast.statements.TypedStatementSerializer
import com.mdeo.script.compiler.CompilationInput
import com.mdeo.script.compiler.CompiledProgram
import com.mdeo.script.compiler.ScriptCompiler
import com.mdeo.script.runtime.ExecutionEnvironment
import com.mdeo.script.runtime.ExternalCallDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.modules.SerializersModule
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File

/** metrics.fn's objectives O1-O5, the harness's default report when metrics.fn is compiled */
private val METRICS_OBJECTIVES = listOf("cost", "failure", "changeCoupling", "inconsistency", "performance")

/**
 * Stage B of this project's headless harness (not part of the platform's test suite). Runs
 * the real optimizer in-process on artefacts exported by the real language services (stage A,
 * `app/arch-harness/export.mjs`) and a config JSON derived by `app/arch-harness/config.mjs`,
 * wired as the worker does (`WorkerSubprocessMain.kt` `buildEvaluatorAndInitialize`).
 *
 * Environment (skipped unless ARCH_MODE is set):
 *   ARCH_MODE     evaluate | operators | apply | run | crossovers
 *   ARCH_BUILD    directory with metamodel.json, <seed>.model.json, scripts/, transformations/
 *   ARCH_OPTIMIZE project directory of the scripts (default /optimize)
 *   ARCH_SEEDS    comma-separated seed model files (evaluate, operators) or one (run)
 *   ARCH_CONFIG   OptimizationConfig JSON file in ARCH_BUILD (operators, run)
 *   ARCH_OUT      output directory (relative to ARCH_BUILD)
 *   ARCH_REPORT   comma-separated `script.fn::function` reported for seeds and solutions (default:
 *                 metrics.fn's objectives O1-O5 when metrics.fn is compiled, else none)
 *   ARCH_SCRIPTS  comma-separated scripts compiled together (default: every exported .fn script)
 *   ARCH_TRIES    operators: attempts per operator and seed (default 30)
 *   ARCH_STEP_TIMES operators: 1 runs each wrapper's top-level statements one by one and prints
 *                 their mean time per application (the first: the generic operator)
 *   ARCH_DIFFS    operators: 1 writes every applied result's diff to <out>/<seed>__<operator>.diffs.jsonl
 *   ARCH_DUMP_BROKEN operators: 1 writes each result that breaks a multiplicity (model and diff from the seed)
 *   ARCH_MIXED    operators: models built from the seeds by operator sequences (default none)
 *   ARCH_EXTERNAL external-function dispatcher for scripts that call plugin functions: unset
 *                 (unsupported), `spawn:<plugin binary>` or `connect:<host>:<port>`
 *                 (ArchExternalCalls); when set, scripts/plugin-ast.json is compiled in
 *   ARCH_LOCK_FILES comma-separated lock files; a run holds between generations while one exists
 *   ARCH_THREADS  run: candidates evaluated (and initial individuals made) at once (ParallelEvaluator, default 1)
 *   ARCH_PLUGINS  plugin services spawned (default 1; ArchExternalCalls); ARCH_PLUGIN_ARENAS their MALLOC_ARENA_MAX
 *   ARCH_TIMING   run: 1 prints per generation the wall and busy time and the plugin calls
 *   ARCH_TRANSFORM apply: the transformation (project path) applied once to each model (ARCH_SEEDS, or
 *                 every *.model.json of ARCH_MODELS_DIR), then once more to check it changes nothing
 *   ARCH_CHECK_SYNC operators, run: a transformation (the layer-3 sync) applied after every operator
 *                 application (operators) or to every evaluated candidate (run); it must change nothing
 *   ARCH_ARCHIVE  run: an external archive of every feasible non-dominated design evaluated
 *                 (ArchiveEvaluator), written to <out>/archive.json; on unless 0
 *   Crossovers: operators are built as mdeo's workers build them
 *   (OperatorCatalog: ids by path and arguments; mutation and crossover operators in separate id
 *   spaces); with `variation = genetic` a run hands the config's crossover operators to
 *   LocalMutationEvaluator. ARCH_MODE=crossovers checks them (see [crossovers]):
 *   ARCH_SEEDS    the children (models a crossover changes)
 *   ARCH_DONORS   the donors (default: the children); each child gets each donor, itself included
 *   ARCH_XO_WALK  `k*n`: per child and donor model, k descendants by n random mutation operators
 *   ARCH_XO_ARGS  more crossover operators with arguments, `file.mt:name=value,name=value;...`
 *   ARCH_XO_MULTI 1: variadic operators also with two donors per child
 *   ARCH_XO_ONLY  only the crossover operators whose label contains one of these (comma-separated)
 *   ARCH_CHECK_SYNC comma-separated transformations each applied to a copy of every result; each
 *                 must change nothing (e.g. /optimize/realised/sync-all.mt)
 *   ARCH_TRIES    applications per operator and (child, donors) (default 5); ARCH_THREADS in parallel
 */
class ArchHarnessTest {

    private val plain = Json { ignoreUnknownKeys = true; prettyPrint = true }

    private val transformationJson = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        serializersModule = SerializersModule {
            contextual(TypedExpression::class, TransformationExpressionSerializer)
            contextual(TypedTransformationStatement::class, TypedTransformationStatementSerializer)
            contextual(TypedPatternElement::class, TypedPatternElementSerializer)
        }
    }

    private val scriptJson = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        serializersModule = SerializersModule {
            contextual(TypedExpression::class, ScriptExpressionSerializer)
            contextual(TypedStatement::class, TypedStatementSerializer)
        }
    }

    private lateinit var dir: File
    private val optimizeDir = (System.getenv("ARCH_OPTIMIZE") ?: "/optimize").trimEnd('/')
    private lateinit var metamodelData: MetamodelData
    private lateinit var compiled: CompiledProgram
    private lateinit var metamodel: Metamodel
    private lateinit var programClass: Class<*>
    /** the scripts compiled together (compileScripts) */
    private var scripts: List<String> = emptyList()
    private var external: ExternalCallDispatcher = ExternalCallDispatcher.UNSUPPORTED

    @Test
    fun `arch harness`() {
        val mode = System.getenv("ARCH_MODE")
        assumeTrue(mode != null, "ARCH_MODE not set")
        dir = File(System.getenv("ARCH_BUILD") ?: error("ARCH_BUILD not set"))
        // the metamodel merged with the files it imports, as the backend loads it for an execution
        val main = plain.decodeFromString(MetamodelData.serializer(), File(dir, "metamodel.json").readText())
        metamodelData = runBlocking {
            MetamodelData.load(main.path) { path ->
                val file = File(dir, "metamodels/" + path.trimStart('/').replace("/", "__") + ".json")
                if (file.exists()) plain.decodeFromString(MetamodelData.serializer(), file.readText()) else null
            } ?: error("cannot load the metamodel ${main.path} with its imports from $dir/metamodels")
        }
        compileScripts()
        // without ARCH_EXTERNAL the scripts are only compiled (for the metamodel): apply and
        // operators (with ARCH_REPORT="") need no plugin
        external = ArchExternalCalls.dispatcher(compiled, out())
        try {
            when (mode) {
                "evaluate" -> evaluate()
                "operators" -> operators()
                "apply" -> apply()
                "run" -> run()
                "crossovers" -> crossovers()
                else -> error("unknown ARCH_MODE $mode")
            }
        } finally {
            ArchExternalCalls.close()
        }
    }

    // ------------------------------------------------------------------------------- scripts

    /** Compiles every exported script together, as the worker compiles the goal's scripts. */
    private fun compileScripts() {
        val files = sortedMapOf<String, ScriptTypedAst>()
        // default: the exported scripts (objectives.fn is gone since 90d545c; the misarch problem's apply, e.g. the
        // layer-3 sync of core/tools/sync_model.py, has none and compiles only for the metamodel)
        val names = System.getenv("ARCH_SCRIPTS")?.split(",")?.map { it.trim() }
            ?: File(dir, "scripts").listFiles { f -> f.name.endsWith(".fn.json") }.orEmpty().map { it.name.removeSuffix(".json") }.sorted()
        scripts = names
        for (name in names) {
            val file = File(dir, "scripts/$name.json")
            files["$optimizeDir/$name"] = scriptJson.decodeFromString(ScriptTypedAst.serializer(), file.readText())
        }
        val pluginFile = File(dir, "scripts/plugin-ast.json")
        val pluginAst = if (pluginFile.exists()) scriptJson.decodeFromString(TypedPluginAst.serializer(), pluginFile.readText()) else null
        compiled = ScriptCompiler().compile(CompilationInput(files, pluginAst), metamodelData)
        metamodel = compiled.metamodel ?: error("no metamodel in compiled program")
        programClass = ExecutionEnvironment(compiled).scriptProgramClass
    }

    private fun function(path: String, name: String, tendency: ObjectiveTendency = ObjectiveTendency.MINIMIZE) =
        ScriptGuidanceFunction(
            programClass,
            compiled.functionLookup[path]?.get(name) ?: error("function $name not found in $path"),
            System.out, "$path::$name", tendency, external
        )

    /** ARCH_REPORT, or by default metrics.fn's objectives when it is compiled (objectives.fn is gone since 90d545c). */
    private fun reportFunctions(): Map<String, ScriptGuidanceFunction> =
        (System.getenv("ARCH_REPORT")
            ?: if ("metrics.fn" in scripts) METRICS_OBJECTIVES.joinToString(",") { "metrics.fn::$it" } else "")
            .split(",").filter { it.isNotBlank() }.associate { spec ->
                val (file, name) = spec.trim().split("::")
                name to function("$optimizeDir/$file", name)
            }

    private fun loadModel(file: String): ModelData =
        plain.decodeFromString(ModelData.serializer(), File(dir, file).readText())

    private fun solutionOf(model: ModelData) = Solution(MdeoModelGraph.create(model, metamodel))

    private fun values(functions: Map<String, ScriptGuidanceFunction>, solution: Solution): JsonObject =
        JsonObject(functions.mapValues { JsonPrimitive(it.value.computeFitness(solution)) })

    private fun out(): File = File(dir, System.getenv("ARCH_OUT") ?: "out").apply { mkdirs() }

    private fun seeds(): List<String> = (System.getenv("ARCH_SEEDS") ?: "misarch-today.model.json").split(",").map { it.trim() }

    // ------------------------------------------------------------------------------- evaluate

    private fun evaluate() {
        val report = reportFunctions()
        val result = JsonObject(seeds().associateWith { seed ->
            val started = System.nanoTime()
            val v = values(report, solutionOf(loadModel(seed)))
            println("$seed: $v (${(System.nanoTime() - started) / 1_000_000} ms)")
            v
        })
        File(out(), "values.json").writeText(plain.encodeToString(JsonObject.serializer(), result))
    }

    // ------------------------------------------------------------------------------- operators

    private fun config(): OptimizationConfig =
        plain.decodeFromString(OptimizationConfig.serializer(), File(dir, System.getenv("ARCH_CONFIG") ?: "config.json").readText())

    /** A transformation's exported typed AST by project path (transformations/<file name>.json). */
    private fun loadAst(path: String): TransformationTypedAst =
        transformationJson.decodeFromString(TransformationTypedAst.serializer(), File(dir, "transformations/${path.substringAfterLast('/')}.json").readText())

    /** An operator's name in reports: its path, with its arguments when it has any. */
    private fun refLabel(ref: OperatorRef) = if (ref.arguments.isEmpty()) ref.path else "${ref.path} (${ref.canonicalArguments})"

    /**
     * The operators of a run: [mutations] by name in id order (index = id), [crossovers] in their
     * own id order. Built as mdeo's workers build them (WorkerSubprocessMain: OperatorCatalog),
     * so ids and arguments are the same; generated mutations take part as `generated:NAME`.
     */
    private class Operators(val mutations: List<Pair<String, TransformationOperator>>, val crossovers: List<CrossoverOperator>) {
        val indexed: Map<String, TransformationOperator> get() = mutations.toMap(LinkedHashMap())
    }

    /**
     * Hand-written mutation operators (by project path, with their arguments) and generated ones
     * (`generated:NAME`), and the crossover operators: those of `search.crossovers` with
     * `variation = genetic` (or [allCrossovers]), plus [extraCrossovers].
     */
    private fun operatorsOf(
        config: OptimizationConfig,
        seed: ModelData,
        log: StringBuilder,
        allCrossovers: Boolean = false,
        extraCrossovers: List<OperatorRef> = emptyList()
    ): Operators {
        val asts = mutableMapOf<String, TransformationTypedAst>()
        val refs = mutableListOf<OperatorRef>()
        for (ref in config.search.mutations.operators) {
            asts.getOrPut(ref.path) { loadAst(ref.path) }
            refs += ref
        }
        when (val preparation = MutationRuleGenerator.prepare(metamodelData, config.search.mutations.generate, config.goal.refinements, seed)) {
            is Preparation.Ready -> {
                log.appendLine("generated operators: " + preparation.result.mutations.map { it.name })
                preparation.result.warnings.forEach { log.appendLine("generator warning: $it") }
                preparation.result.mutations.forEach {
                    asts["generated:${it.name}"] = it.typedAst
                    refs += OperatorRef("generated:${it.name}")
                }
                val generatedDir = File(out(), "generated").apply { mkdirs() }
                preparation.result.mutations.forEach {
                    File(generatedDir, "${it.name}.json").writeText(
                        transformationJson.encodeToString(TransformationTypedAst.serializer(), it.typedAst))
                }
            }
            is Preparation.Rejected -> error("generation rejected: ${preparation.reason}")
        }
        val mutations = OperatorCatalog.sorted(refs).map { refLabel(it) }.zip(OperatorCatalog.mutationOperators(refs, asts))
        val genetic = config.solver.parameters.variation == VariationType.GENETIC
        val crossoverRefs = (if (genetic || allCrossovers) config.search.crossovers.operators else emptyList()) + extraCrossovers
        crossoverRefs.forEach { asts.getOrPut(it.path) { loadAst(it.path) } }
        val crossovers = if (crossoverRefs.isEmpty()) emptyList()
            else OperatorCatalog.crossoverOperators(crossoverRefs, asts, config.solver.parameters.crossover.parents)
        return Operators(mutations, crossovers)
    }

    private fun linkKey(l: com.mdeo.metamodel.data.ModelDataLink) =
        "${l.sourceName}.${l.sourceProperty ?: ""} -- ${l.targetName}.${l.targetProperty ?: ""}"

    /** Instances and links added and removed, for the operator check report. */
    private fun diff(before: ModelData, after: ModelData): JsonObject {
        val bi = before.instances.associateBy { it.name }
        val ai = after.instances.associateBy { it.name }
        val bl = before.links.map { linkKey(it) }.toSet()
        val al = after.links.map { linkKey(it) }.toSet()
        val changed = ai.values.filter { bi[it.name] != null && bi[it.name] != it }.map { "${it.name}: ${it.properties}" }
        return JsonObject(mapOf(
            "addedInstances" to JsonArray(ai.values.filter { it.name !in bi }.map { JsonPrimitive("${it.name}: ${it.className} ${it.properties}") }),
            "removedInstances" to JsonArray(bi.values.filter { it.name !in ai }.map { JsonPrimitive("${it.name}: ${it.className}") }),
            "changedInstances" to JsonArray(changed.map { JsonPrimitive(it) }),
            "addedLinks" to JsonArray((al - bl).sorted().map { JsonPrimitive(it) }),
            "removedLinks" to JsonArray((bl - al).sorted().map { JsonPrimitive(it) })
        ))
    }

    /** The seeds and the "mixed" models built from them by operator sequences (ARCH_MIXED). */
    private fun buildModels(
        seedFiles: List<String>,
        indexed: Map<String, TransformationOperator>,
        runner: TransformationAttemptRunner,
        log: StringBuilder
    ): LinkedHashMap<String, ModelData> {
        val models = linkedMapOf<String, ModelData>()
        seedFiles.forEach { models[it] = loadModel(it) }
        val mixed = System.getenv("ARCH_MIXED") ?: ""
        for (recipe in mixed.split(";").filter { it.isNotBlank() }) {
            val (seedFile, steps) = recipe.split(":", limit = 2)
            val solution = solutionOf(loadModel(seedFile))
            val applied = mutableListOf<String>()
            for (step in steps.split(",")) {
                val (name, times) = step.split("*")
                val operator = indexed[name] ?: error("no operator $name")
                repeat(times.toInt()) {
                    var done = false
                    var attempts = 0
                    while (!done && attempts < 20) {
                        val copy = solution.deepCopy()
                        if (runner.tryApply(copy, operator).isApplied) {
                            solution.modelGraph = copy.modelGraph
                            done = true
                        }
                        attempts++
                    }
                    applied += if (done) name.substringAfterLast(':').substringAfterLast('/') else "(failed ${name})"
                }
            }
            val label = "mixed-" + seedFile
            val model = solution.modelGraph.toModelData()
            models[label] = model
            File(out(), label).writeText(plain.encodeToString(ModelData.serializer(), model))
            log.appendLine("$label built by: $applied")
        }
        return models
    }

    /**
     * Applies every operator ARCH_TRIES times to each seed (a fresh copy each time) and checks the
     * result: the multiplicities of the metamodel (MultiplicityChecker, all ends) and the time one
     * application takes. Besides the seeds, it checks "mixed" models built from them by a fixed
     * sequence of operators (ARCH_MIXED, e.g. `misarch-today.model.json:/optimize/merge-containers.mt*4`).
     */
    private fun operators() {
        val config = config()
        val tries = (System.getenv("ARCH_TRIES") ?: "30").toInt()
        val log = StringBuilder()
        val info = MetamodelInfo(metamodelData)
        val report = reportFunctions()
        val runner = TransformationAttemptRunner()
        val seedFiles = seeds()
        // ARCH_CHECK_SYNC: after every application, a second sync must change nothing (H15)
        val checkOp = System.getenv("ARCH_CHECK_SYNC")?.let { transformation(it) }
        val indexed = operatorsOf(config, loadModel(seedFiles.first()), log).indexed

        val models = buildModels(seedFiles, indexed, runner, log)
        if (System.getenv("MDEO_STMTPROF") == "1") try {
            val cls = Class.forName("com.mdeo.modeltransformation.runtime.StmtProfiler")
            cls.getMethod("reset").invoke(cls.getField("INSTANCE").get(null))
        } catch (e: ClassNotFoundException) { }

        val stepTimes = System.getenv("ARCH_STEP_TIMES") == "1"
        val results = mutableMapOf<String, JsonElement>()
        for ((label, seed) in models) {
            val perOperator = mutableMapOf<String, JsonElement>()
            for ((name, operator) in indexed) {
                var applied = 0
                var failed = 0
                var multiplicityBroken = 0
                var inconsistent = 0
                var nanos = 0L
                var appliedNanos = 0L
                val messages = mutableSetOf<String>()
                var example: JsonObject? = null
                val distinctResults = mutableSetOf<String>()
                val stepNanos = LongArray(operator.ast.statements.size)
                val stepBusy = LongArray(operator.ast.statements.size)
                val stepBusyCount = IntArray(operator.ast.statements.size)
                repeat(tries) {
                    val solution = solutionOf(seed)
                    val t0 = System.nanoTime()
                    // ARCH_STEP_TIMES=1: the wrapper's top-level statements one by one (shuffled as in
                    // an optimisation), timed each; applied when the first (the generic operator) is
                    val isApplied = if (stepTimes) {
                        val context = com.mdeo.modeltransformation.runtime.TransformationExecutionContext.emptyWithEnums(metamodelData.enums.map { it.name })
                        val engine = TransformationEngine.create(solution.modelGraph, operator.ast, deterministic = false)
                        var ok = true
                        for ((i, statement) in operator.ast.statements.withIndex()) {
                            val ts = System.nanoTime()
                            val r = engine.executeStatement(statement, context)
                            val dt = System.nanoTime() - ts
                            stepNanos[i] += dt
                            if (dt > 1_000_000L) { stepBusy[i] += dt; stepBusyCount[i]++ }
                            if (r !is TransformationExecutionResult.Success) {
                                check(i == 0) { "$name: statement $i failed: $r" }
                                ok = false
                                break
                            }
                        }
                        ok
                    } else runner.tryApply(solution, operator).isApplied
                    val dt = System.nanoTime() - t0
                    nanos += dt
                    if (!isApplied) {
                        failed++
                        return@repeat
                    }
                    applied++
                    appliedNanos += dt
                    val after = solution.modelGraph.toModelData()
                    // ARCH_NO_MULT=1: no multiplicity check (timing runs; about a second per application on realised models)
                    val violations = if (System.getenv("ARCH_NO_MULT") == "1") emptyList() else MultiplicityChecker.violations(after, info)
                    if (violations.isNotEmpty()) {
                        multiplicityBroken++
                        messages += violations.take(3)
                        // ARCH_DUMP_BROKEN=1: the broken result and its diff from the seed
                        if (System.getenv("ARCH_DUMP_BROKEN") == "1") {
                            val safe = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")
                            val base = "${label.removeSuffix(".model.json")}__$safe.broken$multiplicityBroken"
                            File(out(), "$base.model.json").writeText(plain.encodeToString(ModelData.serializer(), after))
                            File(out(), "$base.diff.json").writeText(diff(seed, after).toString())
                        }
                    }
                    if (checkOp != null) {
                        val again = solutionOf(after)
                        runner.tryApply(again, checkOp)
                        val dd = diff(after, again.modelGraph.toModelData())
                        if (!dd.values.all { (it as JsonArray).isEmpty() }) {
                            inconsistent++
                            messages += "inconsistent: " + dd.toString().take(300)
                            // ARCH_DUMP_INCONSISTENT=1: the whole difference, one JSON line each
                            if (System.getenv("ARCH_DUMP_INCONSISTENT") == "1") {
                                val safe = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")
                                File(out(), "${label.removeSuffix(".model.json")}__$safe.inconsistent.jsonl").appendText(dd.toString() + "\n")
                            }
                        }
                    }
                    val d = diff(seed, after)
                    distinctResults += d.toString()
                    // ARCH_DIFFS=1: every applied result's diff, one JSON line each
                    if (System.getenv("ARCH_DIFFS") == "1") {
                        val safe = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")
                        File(out(), "${label.removeSuffix(".model.json")}__$safe.diffs.jsonl").appendText(d.toString() + "\n")
                    }
                    if (example == null) {
                        example = JsonObject(mapOf("diff" to d, "values" to values(report, solution)))
                        val safe = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")
                        File(out(), "${label.removeSuffix(".model.json")}__$safe.model.json")
                            .writeText(plain.encodeToString(ModelData.serializer(), after))
                    }
                }
                if (stepTimes && applied > 0) println("    steps (ms per application): " +
                    stepNanos.joinToString(" ") { "%.1f".format(it / 1e6 / applied) } +
                    "; over 1 ms: " + stepBusy.indices.joinToString(" ") { i ->
                        "${stepBusyCount[i]}x" + (if (stepBusyCount[i] > 0) "%.1f".format(stepBusy[i] / 1e6 / stepBusyCount[i]) else "") })
                println("$label $name: applied $applied/$tries, multiplicity-broken $multiplicityBroken, inconsistent $inconsistent, distinct ${distinctResults.size}, ${"%.1f".format(nanos / 1e6 / tries)} ms per try, ${"%.1f".format(if (applied == 0) 0.0 else appliedNanos / 1e6 / applied)} ms per application")
                if (System.getenv("MDEO_STMTPROF") == "1") statementProfile(label, name, tries, applied)
                perOperator[name] = JsonObject(mapOf(
                    "tries" to JsonPrimitive(tries), "applied" to JsonPrimitive(applied), "failed" to JsonPrimitive(failed),
                    "multiplicityBroken" to JsonPrimitive(multiplicityBroken), "inconsistent" to JsonPrimitive(inconsistent),
                    "msPerTry" to JsonPrimitive(nanos / 1_000_000.0 / tries),
                    "msPerApplication" to JsonPrimitive(if (applied == 0) 0.0 else appliedNanos / 1_000_000.0 / applied),
                    "distinctResults" to JsonPrimitive(distinctResults.size),
                    "multiplicityMessages" to JsonArray(messages.map { JsonPrimitive(it) }),
                    "example" to (example ?: JsonPrimitive(null as String?))
                ))
            }
            results[label] = JsonObject(mapOf(
                "seedValues" to values(report, solutionOf(seed)),
                "operators" to JsonObject(perOperator)
            ))
        }
        File(out(), "operators.json").writeText(plain.encodeToString(JsonObject.serializer(), JsonObject(results)))
        File(out(), "log.txt").writeText(log.toString())
        println(log)
    }

    /**
     * MDEO_STMTPROF=1 (operators mode, needs an engine with the profiling hook
     * `com.mdeo.modeltransformation.runtime.StmtProfiler`): the time of every
     * statement the operator ran, at any depth, per try (inclusive, exclusive, matches, match
     * preparation and execution), written to <out>/stmtprof/<seed>__<operator>.tsv; then reset.
     */
    private fun statementProfile(label: String, name: String, tries: Int, applied: Int) {
        val cls = try { Class.forName("com.mdeo.modeltransformation.runtime.StmtProfiler") } catch (e: ClassNotFoundException) { return }
        val inst = cls.getField("INSTANCE").get(null)
        @Suppress("UNCHECKED_CAST")
        val snap = cls.getMethod("snapshot").invoke(inst) as Map<String, Any>
        fun f(o: Any, n: String) = o.javaClass.getMethod("get" + n.replaceFirstChar { it.uppercase() }).invoke(o) as Long
        val rows = snap.entries.map { (k, s) -> listOf(f(s, "count"), f(s, "incl"), f(s, "excl"), f(s, "matches"), f(s, "prep"), f(s, "exec")) to k }
            .sortedByDescending { it.first[2] }
        val dirOut = File(out(), "stmtprof").apply { mkdirs() }
        val safe = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")
        File(dirOut, "${label.removeSuffix(".model.json")}__$safe.tsv").writeText(
            "# tries $tries applied $applied; per try: count incl_ms excl_ms matches prep_ms exec_ms\tstatement\n" +
                rows.joinToString("") { (v, k) ->
                    "%.2f\t%.3f\t%.3f\t%.2f\t%.3f\t%.3f\t%s\n".format(v[0] / tries.toDouble(), v[1] / 1e6 / tries, v[2] / 1e6 / tries,
                        v[3] / tries.toDouble(), v[4] / 1e6 / tries, v[5] / 1e6 / tries, k)
                })
        val tot = rows.sumOf { it.first[2] } / 1e6 / tries
        val stm = rows.sumOf { it.first[0] } / tries.toDouble()
        val m = rows.sumOf { it.first[3] } / tries.toDouble()
        val prep = rows.sumOf { it.first[4] } / 1e6 / tries
        val exec = rows.sumOf { it.first[5] } / 1e6 / tries
        println("    profile per try: %.1f ms in %.0f statements, %.0f matches (prep %.1f ms, exec %.1f ms, other %.1f ms)".format(tot, stm, m, prep, exec, tot - prep - exec))
        cls.getMethod("reset").invoke(inst)
    }

    // ------------------------------------------------------------------------------- apply

    /** An exported transformation by project path (its typed AST in transformations/). */
    private fun transformation(path: String): TransformationOperator {
        val file = File(dir, "transformations/${path.substringAfterLast('/')}.json")
        return TransformationOperator(id = 0, ast = transformationJson.decodeFromString(TransformationTypedAst.serializer(), file.readText()))
    }

    /**
     * Applies ARCH_TRANSFORM (a project path, e.g. /optimize/sync-microservices.mt) once to each of
     * ARCH_SEEDS and writes the result to <out>/<seed>; then applies it to the result again and
     * reports whether that changed anything (a sync is consistent when the second run is a no-op).
     * With ARCH_MODELS_DIR (a directory of *.model.json, absolute or in ARCH_BUILD) instead of
     * ARCH_SEEDS, every model there. Writes <out>/apply.json (per model: applied, ms, the diff of the
     * second run's changes).
     */
    private fun apply() {
        val op = transformation(System.getenv("ARCH_TRANSFORM") ?: error("ARCH_TRANSFORM not set"))
        val runner = TransformationAttemptRunner()
        val out = out()
        val files: List<Pair<String, ModelData>> = System.getenv("ARCH_MODELS_DIR")?.takeIf { it.isNotBlank() }?.let { d ->
            val f = File(d).let { if (it.isAbsolute) it else File(dir, d) }
            (f.listFiles { x -> x.name.endsWith(".model.json") } ?: error("no directory $f")).sortedBy { it.name }
                .map { it.name to plain.decodeFromString(ModelData.serializer(), it.readText()) }
        } ?: seeds().map { File(it).name to loadModel(it) }
        val report = mutableMapOf<String, JsonElement>()
        for ((name, model) in files) {
            val solution = solutionOf(model)
            val t0 = System.nanoTime()
            val first = runner.tryApply(solution, op)
            val ms = (System.nanoTime() - t0) / 1e6
            val synced = solution.modelGraph.toModelData()
            File(out, name).writeText(plain.encodeToString(ModelData.serializer(), synced))
            val again = solutionOf(synced)
            val t1 = System.nanoTime()
            val second = runner.tryApply(again, op)
            val ms2 = (System.nanoTime() - t1) / 1e6
            val d = diff(synced, again.modelGraph.toModelData())
            val clean = d.values.all { (it as JsonArray).isEmpty() }
            println("$name: applied ${first.isApplied} in ${"%.1f".format(ms)} ms; again ${second.isApplied} in ${"%.1f".format(ms2)} ms, ${if (clean) "no change" else "CHANGED: $d"}")
            report[name] = JsonObject(mapOf(
                "applied" to JsonPrimitive(first.isApplied), "ms" to JsonPrimitive(ms),
                "againApplied" to JsonPrimitive(second.isApplied), "againMs" to JsonPrimitive(ms2),
                "consistent" to JsonPrimitive(clean), "againDiff" to d
            ))
        }
        File(out, "apply.json").writeText(plain.encodeToString(JsonObject.serializer(), JsonObject(report)))
    }

    // ------------------------------------------------------------------------------- crossovers

    /** `file.mt:name=value,name=value;...` (ARCH_XO_ARGS): crossover operators with arguments. */
    private fun extraCrossoverRefs(config: OptimizationConfig): List<OperatorRef> =
        (System.getenv("ARCH_XO_ARGS") ?: "").split(";").filter { it.isNotBlank() }.map { spec ->
            val (file, args) = spec.trim().split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            val path = config.search.crossovers.operators.map { it.path }.firstOrNull { it.endsWith("/$file") }
                ?: error("ARCH_XO_ARGS: no crossover operator $file in the config")
            OperatorRef(path, args.split(",").filter { it.isNotBlank() }.associate { a ->
                val (name, value) = a.split("=", limit = 2).map { it.trim() }
                name to when {
                    value == "true" || value == "false" -> ConfigLiteral.BooleanValue(value.toBoolean())
                    value.contains('.') -> ConfigLiteral.DoubleValue(value.toDouble())
                    else -> ConfigLiteral.IntValue(value.toInt())
                }
            })
        }

    private fun isEmptyDiff(d: JsonObject) = d.values.all { (it as JsonArray).isEmpty() }

    /**
     * The crossover operators' check: every crossover operator of the config (and
     * ARCH_XO_ARGS) applied ARCH_TRIES times to every (child, donor) pair of models, each try on a
     * fresh copy of the child, as mdeo's crossover strategy runs it (TransformationAttemptRunner
     * with the donors as model arguments: live graphs of the same metamodel). Children are
     * ARCH_SEEDS, donors ARCH_DONORS (default the children), both with ARCH_XO_WALK descendants; a
     * model is also its own donor (every operator must fail there: the donor agrees everywhere).
     * Per application:
     * - applied: the multiplicities (MultiplicityChecker, unless ARCH_NO_MULT=1) and each of
     *   ARCH_CHECK_SYNC applied to a copy of the result must change nothing (`inconsistent`);
     *   `unchanged` counts applications that changed nothing (an operator that applies should);
     * - failed: the model must equal the child (`failedChanged`: it does not; `failedFlagged`: the
     *   engine reported changes, so mdeo's strategy would restore the child; a failed attempt that
     *   changed the model without saying so would survive into the offspring);
     * - after every try the graph holds no model-input slot, and the donors are unchanged after all
     *   tries of a job (`donorChanged`).
     * Time: ms per application and per failed try (the operator alone). Writes <out>/crossovers.json.
     */
    private fun crossovers() {
        val config = config()
        val tries = (System.getenv("ARCH_TRIES") ?: "5").toInt()
        val threads = (System.getenv("ARCH_THREADS") ?: "1").toInt()
        val noMult = System.getenv("ARCH_NO_MULT") == "1"
        val diffs = System.getenv("ARCH_DIFFS") == "1"
        val log = StringBuilder()
        val info = MetamodelInfo(metamodelData)
        val childFiles = seeds()
        val donorFiles = System.getenv("ARCH_DONORS")?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() } ?: childFiles
        val operators = operatorsOf(config, loadModel(childFiles.first()), log, allCrossovers = true, extraCrossovers = extraCrossoverRefs(config))
        require(operators.crossovers.isNotEmpty()) { "no crossover operators in ${System.getenv("ARCH_CONFIG")}" }
        val checks = (System.getenv("ARCH_CHECK_SYNC") ?: "").split(",").filter { it.isNotBlank() }.map { it.trim() to transformation(it.trim()) }
        val label = { f: String -> f.substringAfterLast('/').removeSuffix(".model.json") }
        val models = linkedMapOf<String, ModelData>()
        (childFiles + donorFiles).distinct().forEach { models[label(it)] = loadModel(it) }
        // ARCH_XO_WALK=k*n: descendants by random walks of the config's mutation operators
        val walkSpec = System.getenv("ARCH_XO_WALK")?.takeIf { it.isNotBlank() }?.split("*")?.map { it.trim().toInt() }
        val walked = mutableMapOf<String, List<String>>()
        if (walkSpec != null) {
            val (k, n) = walkSpec
            val walk = MutationStrategyFactory.create(
                config.solver.parameters.mutation.copy(step = MutationStepConfig.Fixed(n)), operators.mutations.map { it.second })
            val walkDir = File(out(), "walks").apply { mkdirs() }
            for (base in models.keys.toList()) {
                walked[base] = (1..k).map { i ->
                    val name = "$base-w$i"
                    val model = walk.mutate(solutionOf(models.getValue(base))).modelGraph.toModelData()
                    models[name] = model
                    File(walkDir, "$name.model.json").writeText(plain.encodeToString(ModelData.serializer(), model))
                    name
                }
            }
            log.appendLine("walks: $k per model, $n mutation operators each")
        }
        val children = childFiles.map { label(it) }.flatMap { listOf(it) + (walked[it] ?: emptyList()) }
        val donors = donorFiles.map { label(it) }.flatMap { listOf(it) + (walked[it] ?: emptyList()) }
        class Job(val child: String, val donors: List<String>, val operator: CrossoverOperator)
        val jobs = mutableListOf<Job>()
        // ARCH_XO_ONLY: only the crossover operators whose label contains one of these (comma-separated)
        val only = System.getenv("ARCH_XO_ONLY")?.split(",")?.filter { it.isNotBlank() }
        val selected = operators.crossovers.filter { op -> only == null || only.any { op.label.contains(it) } }
        for (child in children) for (operator in selected) {
            for (donor in donors) jobs += Job(child, listOf(donor), operator)
            // ARCH_XO_MULTI=1: a variadic operator also with two donors (the first two others)
            if (System.getenv("ARCH_XO_MULTI") == "1" && operator.isVariadic) {
                val two = donors.filter { it != child }.take(2)
                if (two.size == 2) jobs += Job(child, two, operator)
            }
        }
        log.appendLine("crossover operators: ${operators.crossovers.map { it.label }}; children ${children.size}, donors ${donors.size}, " +
            "${jobs.size} jobs × $tries tries, checks ${checks.map { it.first }}")
        println(log)

        class Outcome(val job: Job) {
            var applied = 0; var failed = 0; var failedChanged = 0; var failedFlagged = 0; var unchanged = 0
            var multiplicityBroken = 0; var donorChanged = 0; var slotsLeft = 0
            val inconsistent = IntArray(checks.size)
            var appliedNanos = 0L; var failedNanos = 0L; var checkNanos = 0L
            val distinct = mutableSetOf<String>()
            val messages = mutableListOf<String>()
            val changedInstances = mutableListOf<Int>()
        }
        val pool = java.util.concurrent.Executors.newFixedThreadPool(threads)
        val done = java.util.concurrent.atomic.AtomicInteger()
        val futures = jobs.map { job ->
            pool.submit<Outcome> {
                val o = Outcome(job)
                val runner = TransformationAttemptRunner()
                val childData = models.getValue(job.child)
                val donorGraphs = job.donors.map { MdeoModelGraph.create(models.getValue(it), metamodel) }
                val donorsBefore = donorGraphs.map { it.toModelData() }
                val safe = "${job.child}__${job.operator.label.replace(Regex("[^A-Za-z0-9_.=-]"), "_")}__${job.donors.joinToString("+")}"
                repeat(tries) {
                    val solution = solutionOf(childData)
                    val t0 = System.nanoTime()
                    val result = runner.tryApply(solution, job.operator.operator, job.operator.modelArguments(donorGraphs))
                    val dt = System.nanoTime() - t0
                    if (solution.modelGraph.modelInputSlots.isNotEmpty()) {
                        o.slotsLeft++
                        o.messages += "model-input slots left: ${solution.modelGraph.modelInputSlots}"
                    }
                    val after = solution.modelGraph.toModelData()
                    val d = diff(childData, after)
                    if (result !is com.mdeo.optimizer.operators.TransformationAttemptResult.Applied) {
                        o.failed++
                        o.failedNanos += dt
                        val flagged = (result as com.mdeo.optimizer.operators.TransformationAttemptResult.Failure).changesWereMade
                        if (flagged) o.failedFlagged++
                        if (!isEmptyDiff(d)) {
                            o.failedChanged++
                            if (o.messages.size < 6) o.messages += "failed but changed (engine flag $flagged): " + d.toString().take(300)
                        }
                        return@repeat
                    }
                    o.applied++
                    o.appliedNanos += dt
                    if (isEmptyDiff(d)) o.unchanged++
                    o.distinct += d.toString()
                    o.changedInstances += d.values.sumOf { (it as JsonArray).size }
                    if (diffs) File(out(), "$safe.diffs.jsonl").appendText(d.toString() + "\n")
                    val tc = System.nanoTime()
                    if (!noMult) {
                        val violations = MultiplicityChecker.violations(after, info)
                        if (violations.isNotEmpty()) {
                            o.multiplicityBroken++
                            if (o.messages.size < 6) o.messages += "multiplicity: " + violations.take(3)
                        }
                    }
                    for ((i, check) in checks.withIndex()) {
                        val again = solutionOf(after)
                        runner.tryApply(again, check.second)
                        val dd = diff(after, again.modelGraph.toModelData())
                        if (!isEmptyDiff(dd)) {
                            o.inconsistent[i]++
                            if (o.messages.size < 6) o.messages += "inconsistent (${check.first}): " + dd.toString().take(300)
                            if (System.getenv("ARCH_DUMP_INCONSISTENT") == "1") {
                                File(out(), "$safe.inconsistent.jsonl").appendText(dd.toString() + "\n")
                                File(out(), "$safe.inconsistent${o.inconsistent[i]}.model.json").writeText(plain.encodeToString(ModelData.serializer(), after))
                            }
                        }
                    }
                    o.checkNanos += System.nanoTime() - tc
                    if (o.applied == 1 && System.getenv("ARCH_XO_KEEP") == "1") {
                        File(out(), "$safe.model.json").writeText(plain.encodeToString(ModelData.serializer(), after))
                    }
                }
                if (donorGraphs.map { it.toModelData() } != donorsBefore) {
                    o.donorChanged++
                    o.messages += "DONOR CHANGED"
                }
                donorGraphs.forEach { it.close() }
                val n = done.incrementAndGet()
                if (n % 20 == 0) println("  $n/${jobs.size} jobs")
                o
            }
        }
        val outcomes = futures.map { it.get() }
        pool.shutdown()

        val ms = { n: Long, k: Int -> if (k == 0) 0.0 else n / 1e6 / k }
        val perJob = mutableListOf<JsonObject>()
        for (o in outcomes) {
            val self = o.job.donors == listOf(o.job.child)
            println("${o.job.child} <- ${o.job.donors.joinToString("+")}${if (self) " (self)" else ""} ${o.job.operator.label}: " +
                "applied ${o.applied}/$tries, failed ${o.failed} (changed ${o.failedChanged}, flagged ${o.failedFlagged}), unchanged ${o.unchanged}, " +
                "distinct ${o.distinct.size}, multiplicity ${o.multiplicityBroken}, inconsistent ${o.inconsistent.toList()}, donor changed ${o.donorChanged}, " +
                "%.1f ms per application, %.1f ms per failed try, checks %.0f ms".format(ms(o.appliedNanos, o.applied), ms(o.failedNanos, o.failed), ms(o.checkNanos, o.applied)) +
                (if (o.changedInstances.isEmpty()) "" else ", diff size ${o.changedInstances.min()}–${o.changedInstances.max()}"))
            o.messages.take(3).forEach { println("    $it") }
            perJob += JsonObject(mapOf(
                "child" to JsonPrimitive(o.job.child), "donors" to JsonArray(o.job.donors.map { JsonPrimitive(it) }),
                "operator" to JsonPrimitive(o.job.operator.label), "self" to JsonPrimitive(self),
                "tries" to JsonPrimitive(tries), "applied" to JsonPrimitive(o.applied), "failed" to JsonPrimitive(o.failed),
                "failedChanged" to JsonPrimitive(o.failedChanged), "failedFlagged" to JsonPrimitive(o.failedFlagged),
                "unchanged" to JsonPrimitive(o.unchanged), "distinct" to JsonPrimitive(o.distinct.size),
                "multiplicityBroken" to JsonPrimitive(o.multiplicityBroken),
                "inconsistent" to JsonArray(o.inconsistent.map { JsonPrimitive(it) }),
                "donorChanged" to JsonPrimitive(o.donorChanged), "slotsLeft" to JsonPrimitive(o.slotsLeft),
                "msPerApplication" to JsonPrimitive(ms(o.appliedNanos, o.applied)), "msPerFailedTry" to JsonPrimitive(ms(o.failedNanos, o.failed)),
                "diffSizes" to JsonArray(o.changedInstances.map { JsonPrimitive(it) }),
                "messages" to JsonArray(o.messages.map { JsonPrimitive(it) })
            ))
        }
        // per operator, self pairs apart
        println("\nper operator (other donors | self):")
        for (operator in operators.crossovers) {
            for (self in listOf(false, true)) {
                val os = outcomes.filter { it.job.operator === operator && (it.job.donors == listOf(it.job.child)) == self }
                if (os.isEmpty()) continue
                val applied = os.sumOf { it.applied }
                val failed = os.sumOf { it.failed }
                val line = "%s%s: applied %d, failed %d (changed %d, flagged %d), unchanged %d, multiplicity %d, inconsistent %s, donor changed %d, slots left %d, %.1f ms per application, %.1f ms per failed try".format(
                    operator.label, if (self) " (self)" else "", applied, failed, os.sumOf { it.failedChanged }, os.sumOf { it.failedFlagged },
                    os.sumOf { it.unchanged }, os.sumOf { it.multiplicityBroken },
                    checks.indices.map { i -> os.sumOf { it.inconsistent[i] } }, os.sumOf { it.donorChanged }, os.sumOf { it.slotsLeft },
                    ms(os.sumOf { it.appliedNanos }, applied), ms(os.sumOf { it.failedNanos }, failed))
                println(line)
                log.appendLine(line)
            }
        }
        File(out(), "crossovers.json").writeText(plain.encodeToString(JsonArray.serializer(), JsonArray(perJob)))
        File(out(), "log.txt").writeText(log.toString())
    }

    // ------------------------------------------------------------------------------- run

    private fun run() {
        val config = config()
        val seedFile = seeds().single()
        val seed = loadModel(seedFile)
        val out = out()
        val log = StringBuilder()
        val operators = operatorsOf(config, seed, log)
        val operatorNames = operators.mutations.map { it.first }
        log.appendLine("operators (${operatorNames.size}): $operatorNames")
        val crossoverLabels = operators.crossovers.map { it.label }
        val crossover = config.solver.parameters.crossover
        log.appendLine("variation: ${config.solver.parameters.variation}" + if (crossoverLabels.isEmpty()) "" else
            ", crossover operators (${crossoverLabels.size}): $crossoverLabels, rate ${crossover.rate}, parents ${crossover.parents}, strategy ${crossover.strategy}")
        val objectives = config.goal.objectives.map { function(it.path, it.functionName, it.type) }
        val constraints = config.goal.constraints.map { function(it.path, it.functionName) }
        val report = reportFunctions()
        val seedValues = values(report, solutionOf(seed))
        log.appendLine("seed $seedFile: $seedValues")

        val operatorList = operators.mutations.map { it.second }
        val mutationStrategy = TimedMutationStrategy(MutationStrategyFactory.create(config.solver.parameters.mutation, operatorList))
        // variation = genetic: the crossover strategy of mdeo's workers (WorkerSubprocessMain), timed
        val crossoverStrategy = operators.crossovers.takeIf { it.isNotEmpty() }?.let {
            TimedCrossoverStrategy(CrossoverStrategyFactory.create(crossover, it))
        }
        val local = LocalMutationEvaluator(
            initialSolutionProvider = { solutionOf(seed) },
            mutationStrategy = mutationStrategy,
            objectives = objectives,
            constraints = constraints,
            metamodel = metamodel,
            crossoverStrategy = crossoverStrategy
        )
        // ARCH_THREADS candidates at once, as the platform's worker threads (ParallelEvaluator);
        // the archive's decisions are read on the evaluation threads
        val threads = (System.getenv("ARCH_THREADS") ?: "1").toInt()
        val archiveOn = System.getenv("ARCH_ARCHIVE") != "0"
        val decisions = ArchiveEvaluator.Decisions(seed)
        val parallel = ParallelEvaluator(local, threads, if (archiveOn) { m -> decisions.of(m.toModelData()) } else null, crossoverLabels)
        // the external archive: sees every evaluation, changes nothing in the search
        val archive = if (!archiveOn) null else ArchiveEvaluator(parallel, metamodel, seed, parallel)
        val archived: MutationEvaluator = archive ?: parallel
        // ARCH_CHECK_SYNC (a transformation, e.g. /optimize/sync-microservices.mt): every evaluated
        // candidate is fetched and the sync applied to a copy of it; a candidate is consistent when
        // that changes nothing (H15). Counts go to the log; the first few diffs too.
        val checkOp = System.getenv("ARCH_CHECK_SYNC")?.let { transformation(it) }
        val checked = intArrayOf(0, 0)
        val checkRunner = TransformationAttemptRunner()
        val base: MutationEvaluator = if (checkOp == null) archived else object : MutationEvaluator by archived {
            override suspend fun executeNodeBatches(batches: List<com.mdeo.optimizer.evaluation.NodeBatch>): List<com.mdeo.optimizer.evaluation.EvaluationResult> {
                val results = archived.executeNodeBatches(batches)
                for (r in results) {
                    if (r.status != com.mdeo.optimizer.evaluation.ResultStatus.SUCCESS) continue
                    val model = archived.getSolutionData(WorkerSolutionRef(r.workerNodeId, r.newSolutionId)).toModelData(metamodel)
                    val copy = solutionOf(model)
                    checkRunner.tryApply(copy, checkOp)
                    val d = diff(model, copy.modelGraph.toModelData())
                    checked[0]++
                    if (!d.values.all { (it as JsonArray).isEmpty() }) {
                        checked[1]++
                        if (checked[1] <= 5) log.appendLine("INCONSISTENT candidate ${r.newSolutionId}: $d")
                    }
                }
                return results
            }
        }
        val evaluator: MutationEvaluator = base
        log.appendLine("evaluation threads: $threads")
        val started = System.currentTimeMillis()
        val batches = mutableListOf<JsonArray>()
        // solutions must be fetched while their batch is still held by the evaluator
        val results = runBlocking {
            OptimizationOrchestrator(config, evaluator).run(onGenerationComplete = { batchIndex, generation ->
                // step `generation` (1-based; step 1 evaluates the initial population) is done; the
                // archive labels what follows with the history index of the next step
                archive?.generation = generation
                if (generation % 50 == 0) archive?.let { println("generation $generation: archive ${it.size}") }
                // machine-load protocol: hold the run between generations while a measurement
                // window (or its reservation) is active; the plugin sessions stay alive meanwhile
                val locks = (System.getenv("ARCH_LOCK_FILES") ?: "").split(",").filter { it.isNotBlank() }.map { File(it) }
                if (locks.any { it.exists() }) {
                    val since = System.currentTimeMillis()
                    println("generation $generation of batch $batchIndex done; paused while a lock exists: $locks")
                    while (locks.any { it.exists() }) kotlinx.coroutines.delay(10_000)
                    log.appendLine("paused ${(System.currentTimeMillis() - since) / 1000} s after generation $generation (measurement lock)")
                }
            }, onBatchComplete = { batchIndex, result, durationMs ->
                val batch = batchIndex - 1
                val refs = result.getRawPopulation().map { it.getWorkerRef() }
                val solutions = result.getFinalSolutions().mapIndexed { index, values ->
                    val ref = refs[index] ?: error("solution without worker ref")
                    val model = evaluator.getSolutionData(ref).toModelData(metamodel)
                    val file = "batch${batch}_solution$index.model.json"
                    File(out, file).writeText(plain.encodeToString(ModelData.serializer(), model))
                    JsonObject(mapOf(
                        "objectives" to JsonArray(values.objectives.map { JsonPrimitive(it) }),
                        "constraints" to JsonArray(values.constraints.map { JsonPrimitive(it) }),
                        "report" to values(report, solutionOf(model)),
                        "model" to JsonPrimitive(file)
                    ))
                }
                // per-generation Pareto fronts (MOEA minimisation form: maximised objectives negated)
                val history = result.getParetoFrontHistory().map { front ->
                    JsonArray(front.map { s ->
                        JsonObject(mapOf(
                            "o" to JsonArray(s.objectives.map { JsonPrimitive(it) }),
                            "c" to JsonArray(s.constraints.map { JsonPrimitive(it) })
                        ))
                    })
                }
                File(out, "history_batch$batch.json").writeText(plain.encodeToString(JsonArray.serializer(), JsonArray(history)))
                val generations = result.getMetrics().generations
                log.appendLine(
                    "batch $batch: ${solutions.size} solutions in the final front, $durationMs ms, " +
                        "${generations.size} generations, " +
                        "${generations.sumOf { it.executedTransformations }} transformations tried, " +
                        "${generations.sumOf { it.skippedOperatorSlots }} operator slots skipped"
                )
                if (crossoverLabels.isNotEmpty()) {
                    val perOperator = crossoverLabels.indices.associate { id ->
                        crossoverLabels[id] to generations.sumOf { it.crossover.perOperator[id] ?: 0 }
                    }
                    log.appendLine(
                        "batch $batch crossovers: attempted ${generations.sumOf { it.crossover.attempted }}, " +
                            "succeeded ${generations.sumOf { it.crossover.succeeded }}, fell back ${generations.sumOf { it.crossover.fellBack }}; " +
                            "applied per operator $perOperator; per generation (attempted/succeeded) " +
                            generations.joinToString(" ") { "${it.crossover.attempted}/${it.crossover.succeeded}" }
                    )
                }
                batches.add(JsonArray(solutions))
            })
        }
        log.appendLine("search took ${System.currentTimeMillis() - started} ms for ${results.size} batch(es)")
        log.appendLine("offspring (ms per offspring, mean):\n" + parallel.variationSummary())
        if (checkOp != null) log.appendLine("consistency: ${checked[0]} candidates checked, ${checked[1]} inconsistent")
        archive?.let {
            File(out, "archive.json").writeText(plain.encodeToString(JsonObject.serializer(), it.toJson()))
            log.appendLine("archive: ${it.size} non-dominated feasible designs of ${it.evaluated} evaluated")
        }
        runBlocking { evaluator.cleanup() }
        File(out, "front.json").writeText(plain.encodeToString(JsonObject.serializer(), JsonObject(mapOf(
            "seed" to JsonPrimitive(seedFile),
            "seedValues" to seedValues,
            "objectives" to JsonArray(config.goal.objectives.map { JsonPrimitive("${it.type} ${it.functionName}") }),
            "constraints" to JsonArray(config.goal.constraints.map { JsonPrimitive(it.functionName) }),
            "batches" to JsonArray(batches)
        ))))
        File(out, "log.txt").writeText(log.toString())
        println(log)
    }
}
