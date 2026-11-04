package com.mdeo.optimizer

import com.mdeo.metamodel.Metamodel
import com.mdeo.metamodel.data.ModelData
import com.mdeo.optimizer.evaluation.EvaluationResult
import com.mdeo.optimizer.evaluation.MutationEvaluator
import com.mdeo.optimizer.evaluation.NodeBatch
import com.mdeo.optimizer.evaluation.ResultStatus
import com.mdeo.optimizer.evaluation.WorkerSolutionRef
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * An external archive of every feasible, non-dominated design the run evaluates.
 * With four objectives NSGA-II keeps only as many non-dominated designs as its population and
 * drops some by crowding distance, so its final front loses designs it had found; the archive
 * keeps them. It wraps the evaluator: after each batch it reads the objectives of the evaluated
 * candidates, and for each that enters the archive it fetches the model once and keeps only its
 * decisions (the targets of `resourceContainer`, `mechanism`, `style` and `home` links that differ from
 * the seed). Entries that a newcomer dominates leave the archive, with the generation they left,
 * so the archive at any generation can be rebuilt (`born` <= g < `died`). Equal objective vectors
 * count once (the first design is kept). The search itself is not changed.
 *
 * ARCH_DESIGNS=1: every evaluated design is also written to <ARCH_BUILD>/<ARCH_OUT>/
 * designs.jsonl, one line each: {"i", "g" (generation), "o", "c", "d" (its decisions that differ
 * from the seed)}, for the explorer's exporter (contract 0.2.0: every evaluated design); with a
 * [DecisionSource] that records variations (ParallelEvaluator) also "v": how the design was made
 * ({"k": mutation | copy | crossover | fallback, "x": the crossover operator that applied, "xa":
 * crossover operators tried, "ms": [crossover, mutation, whole task] in ms).
 */
class ArchiveEvaluator(
    private val inner: MutationEvaluator,
    private val metamodel: Metamodel,
    seed: ModelData,
    private val source: DecisionSource? = null
) : MutationEvaluator by inner {

    private val decisions = Decisions(seed)

    /** A design's decisions: the decision links that differ from the seed's. */
    class Decisions(seed: ModelData) {
        private val decisionProperties = setOf("resourceContainer", "mechanism", "style", "home")
        private val seedDecisions = all(seed)

        private fun all(model: ModelData): Map<String, String> =
            model.links.filter { it.sourceProperty in decisionProperties }
                .associate { "${it.sourceName}.${it.sourceProperty}" to it.targetName }

        fun of(model: ModelData): Map<String, String> = all(model).filter { seedDecisions[it.key] != it.value }
    }

    /** The decisions of [r]'s design: recorded where it was evaluated, else fetched (whole model). */
    private suspend fun designOf(r: EvaluationResult): Map<String, String> =
        source?.takeDecisions(r.newSolutionId)
            ?: decisions.of(inner.getSolutionData(WorkerSolutionRef(r.workerNodeId, r.newSolutionId)).toModelData(metamodel))

    private class Entry(val o: List<Double>, val born: Int, var design: Map<String, String>?) {
        var died: Int? = null
    }

    private val designsOut: java.io.Writer? = if (System.getenv("ARCH_DESIGNS") == "1") {
        val outDir = java.io.File(System.getenv("ARCH_BUILD") ?: ".", System.getenv("ARCH_OUT") ?: "out").apply { mkdirs() }
        java.io.File(outDir, "designs.jsonl").bufferedWriter()
    } else null

    private val alive = mutableListOf<Entry>()
    private val dead = mutableListOf<Entry>()

    /** The generation now being evaluated (0 = the initial population). */
    @Volatile
    var generation = 0
    var evaluated = 0
        private set

    private fun dominates(a: List<Double>, b: List<Double>): Boolean {
        var strictly = false
        for (i in a.indices) {
            if (a[i] > b[i] + 1e-12) return false
            if (a[i] < b[i] - 1e-12) strictly = true
        }
        return strictly
    }

    private fun same(a: List<Double>, b: List<Double>) = a.indices.all { i -> kotlin.math.abs(a[i] - b[i]) <= 1e-12 }

    private suspend fun offer(r: EvaluationResult) {
        if (r.status != ResultStatus.SUCCESS) return
        evaluated++
        // taken once per result (the source forgets it), whether or not it is needed below
        var design: Map<String, String>? = if (designsOut != null || source != null) designOf(r) else null
        val variation = source?.takeVariation(r.newSolutionId)
        if (designsOut != null && design != null) {
            designsOut.write(JsonObject(buildMap {
                put("i", JsonPrimitive(evaluated - 1))
                put("g", JsonPrimitive(generation))
                put("o", JsonArray(r.objectives.map { JsonPrimitive(it) }))
                put("c", JsonArray(r.constraints.map { JsonPrimitive(it) }))
                put("d", JsonObject(design.toSortedMap().mapValues { JsonPrimitive(it.value) }))
                if (variation != null) put("v", variation)
            }).toString())
            designsOut.write("\n")
        }
        if (r.constraints.any { it > 0.0 }) return
        val o = r.objectives
        if (alive.any { dominates(it.o, o) || same(it.o, o) }) return
        if (design == null) design = designOf(r)
        val gone = alive.filter { dominates(o, it.o) }
        gone.forEach { it.died = generation; it.design = null }
        alive.removeAll(gone.toSet())
        dead.addAll(gone)
        alive.add(Entry(o, generation, design))
    }

    /** Flushes and closes designs.jsonl (ARCH_DESIGNS=1). */
    fun close() {
        designsOut?.close()
    }

    override suspend fun executeNodeBatches(batches: List<NodeBatch>): List<EvaluationResult> {
        val results = inner.executeNodeBatches(batches)
        val t0 = System.nanoTime()
        for (r in results) offer(r)
        designsOut?.flush()
        if (System.getenv("ARCH_TIMING") == "1") println("timing archive: ${results.size} results, ${(System.nanoTime() - t0) / 1_000_000} ms")
        return results
    }

    val size: Int get() = alive.size

    /** The archive and every entry that left it (objectives and generations only). */
    fun toJson(): JsonObject = JsonObject(mapOf(
        "evaluated" to JsonPrimitive(evaluated),
        "generations" to JsonPrimitive(generation),
        "front" to JsonArray(alive.map { e ->
            JsonObject(mapOf(
                "o" to JsonArray(e.o.map { JsonPrimitive(it) }),
                "born" to JsonPrimitive(e.born),
                "design" to JsonObject((e.design ?: emptyMap()).toSortedMap().mapValues { JsonPrimitive(it.value) })
            ))
        }),
        "left" to JsonArray(dead.map { e ->
            JsonObject(mapOf(
                "o" to JsonArray(e.o.map { JsonPrimitive(it) }),
                "born" to JsonPrimitive(e.born),
                "died" to (e.died?.let { JsonPrimitive(it) } ?: JsonNull)
            ))
        })
    ))
}
