package com.mdeo.optimizer

import com.mdeo.metamodel.SerializedModel
import com.mdeo.optimizer.evaluation.EvaluationResult
import com.mdeo.optimizer.evaluation.InitialSolutionResult
import com.mdeo.optimizer.evaluation.LocalMutationEvaluator
import com.mdeo.optimizer.evaluation.MutationEvaluator
import com.mdeo.optimizer.evaluation.NodeBatch
import com.mdeo.optimizer.evaluation.ResultStatus
import com.mdeo.optimizer.evaluation.WorkerSolutionRef
import com.mdeo.optimizer.operators.CrossoverOutcome
import com.mdeo.optimizer.operators.CrossoverStrategy
import com.mdeo.optimizer.operators.MutationStrategy
import com.mdeo.optimizer.solution.Solution
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.coroutines.async
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * The decisions of evaluated designs (ArchiveEvaluator, designs.jsonl), read where the design is
 * held: by the evaluation thread that made it (ParallelEvaluator) or by the worker node that holds
 * it (NodeEvaluators), so the coordinator never serialises a whole model for them.
 */
interface DecisionSource {
    /** The decisions recorded for [solutionId] (removed: each is asked for once), or null. */
    fun takeDecisions(solutionId: String): Map<String, String>?

    /** How [solutionId] was made (kind, crossover operator, times; removed: asked for once), or null. */
    fun takeVariation(solutionId: String): JsonObject? = null
}

/**
 * The time one offspring's variation takes on its evaluation thread (crossover and mutation), for
 * [ParallelEvaluator]'s per-offspring record: [TimedMutationStrategy] and [TimedCrossoverStrategy]
 * add to the slot of the current thread, which [ParallelEvaluator] resets before a task and reads
 * after it (a task runs on one thread: [LocalMutationEvaluator] does not suspend).
 */
object VariationTiming {
    class Slot {
        var crossoverNanos = 0L
        var mutationNanos = 0L
        var crossoverAttempts = 0
    }

    private val current = ThreadLocal.withInitial { Slot() }

    fun reset(): Slot = Slot().also { current.set(it) }

    fun slot(): Slot = current.get()
}

/** [inner], timed into [VariationTiming] (changes nothing else). */
class TimedMutationStrategy(private val inner: MutationStrategy) : MutationStrategy {
    override fun mutate(solution: Solution): Solution {
        val t0 = System.nanoTime()
        try {
            return inner.mutate(solution)
        } finally {
            VariationTiming.slot().mutationNanos += System.nanoTime() - t0
        }
    }
}

/** [inner], timed into [VariationTiming] (changes nothing else). */
class TimedCrossoverStrategy(private val inner: CrossoverStrategy) : CrossoverStrategy {
    override fun crossover(child: Solution, primary: Solution, donors: List<Solution>): CrossoverOutcome {
        val t0 = System.nanoTime()
        val slot = VariationTiming.slot()
        try {
            return inner.crossover(child, primary, donors).also { slot.crossoverAttempts += it.attempts }
        } finally {
            slot.crossoverNanos += System.nanoTime() - t0
        }
    }
}

/**
 * [LocalMutationEvaluator] evaluates the tasks of a batch one after the other. The platform's
 * worker (`WorkerSubprocessMain.handleWsNodeWorkBatch`) instead runs every task as a batch of its
 * own on a pool of `workerThreads` threads. This does the same for the headless harness, so that
 * [threads] candidates are mutated and simulated at once (each thread with its own plugin
 * session, ArchExternalCalls). The initial individuals (the seed and mdeo's mutation)
 * are made on the pool too, one per task.
 *
 * [decisions] (optional): called on the evaluation thread for every successful result with the
 * design's model; what it returns is kept for [takeDecisions].
 *
 * Crossover tasks (variation = genetic) run one per thread like mutation tasks; a
 * single node has every donor, so there are no replicas to receive. Every offspring's variation is
 * recorded ([takeVariation], [variationSummary]): its kind (`mutation`: a mutation task; `copy`: a
 * crossover task without a crossover attempt; `crossover`: an operator applied; `fallback`: every
 * operator failed, the child is its primary), the crossover operator ([crossoverLabels], by id),
 * and the time of the crossover, of the mutation and of the whole task (with its evaluation).
 */
class ParallelEvaluator(
    private val inner: LocalMutationEvaluator,
    threads: Int,
    private val decisions: ((com.mdeo.metamodel.Model) -> Map<String, String>)? = null,
    private val crossoverLabels: List<String> = emptyList()
) : MutationEvaluator, DecisionSource {
    private val pool = Executors.newFixedThreadPool(threads).asCoroutineDispatcher()
    private val timing = System.getenv("ARCH_TIMING") == "1"
    private val recorded = ConcurrentHashMap<String, Map<String, String>>()

    override fun takeDecisions(solutionId: String): Map<String, String>? = recorded.remove(solutionId)

    private val variations = ConcurrentHashMap<String, JsonObject>()

    override fun takeVariation(solutionId: String): JsonObject? = variations.remove(solutionId)

    /** Per kind (and per applied crossover operator): offspring, failed tasks, summed times. */
    private class Totals {
        var count = 0
        var failed = 0
        var crossoverNanos = 0L
        var mutationNanos = 0L
        var totalNanos = 0L
        var attempts = 0
    }

    private val totals = sortedMapOf<String, Totals>()

    private fun variationOf(r: EvaluationResult, crossoverTask: Boolean, slot: VariationTiming.Slot, nanos: Long) {
        val kind = when {
            !crossoverTask -> "mutation"
            !r.crossoverAttempted -> "copy"
            r.crossoverOperator != null -> "crossover"
            else -> "fallback"
        }
        val operator = r.crossoverOperator?.let { crossoverLabels.getOrElse(it) { "crossover $it" } }
        synchronized(totals) {
            for (key in listOfNotNull(kind, operator?.let { "crossover $it" })) {
                val t = totals.getOrPut(key) { Totals() }
                if (r.status != ResultStatus.SUCCESS) { t.failed++; continue }
                t.count++
                t.crossoverNanos += slot.crossoverNanos
                t.mutationNanos += slot.mutationNanos
                t.totalNanos += nanos
                t.attempts += slot.crossoverAttempts
            }
        }
        if (r.status != ResultStatus.SUCCESS) return
        val ms = { n: Long -> JsonPrimitive(Math.round(n / 1e4) / 100.0) }
        variations[r.newSolutionId] = JsonObject(buildMap {
            put("k", JsonPrimitive(kind))
            if (operator != null) put("x", JsonPrimitive(operator))
            if (r.crossoverAttempted) put("xa", JsonPrimitive(slot.crossoverAttempts))
            // crossover, mutation, whole task (with the evaluation), ms
            put("ms", JsonArray(listOf(ms(slot.crossoverNanos), ms(slot.mutationNanos), ms(nanos))))
        })
    }

    /** Offspring per kind with mean times (ms): crossover, mutation, variation (both), whole task. */
    fun variationSummary(): String = synchronized(totals) {
        totals.entries.joinToString("\n") { (key, t) ->
            val mean = { n: Long -> if (t.count == 0) 0.0 else n / 1e6 / t.count }
            "  %s: %d offspring%s, crossover %.1f ms, mutation %.1f ms, variation %.1f ms, task %.0f ms%s".format(
                key, t.count, if (t.failed > 0) " (+${t.failed} failed)" else "",
                mean(t.crossoverNanos), mean(t.mutationNanos), mean(t.crossoverNanos + t.mutationNanos), mean(t.totalNanos),
                if (t.attempts > 0) ", %.2f crossover operators tried".format(t.attempts.toDouble() / t.count) else "")
        }
    }

    override suspend fun initialize(count: Int): List<InitialSolutionResult> = coroutineScope {
        val started = System.nanoTime()
        val results = (0 until count).map { async(pool) { inner.initialize(1) } }.awaitAll().flatten()
        if (timing) println("timing initialize: $count in ${(System.nanoTime() - started) / 1_000_000} ms")
        results
    }

    private fun record(results: List<EvaluationResult>) {
        val of = decisions ?: return
        for (r in results) if (r.status == ResultStatus.SUCCESS) recorded[r.newSolutionId] = of(inner.solutionModel(r.newSolutionId))
    }

    override suspend fun executeNodeBatches(batches: List<NodeBatch>): List<EvaluationResult> = coroutineScope {
        val results = mutableListOf<EvaluationResult>()
        for (batch in batches) {
            val started = System.nanoTime()
            val busy = AtomicLong()
            val longest = AtomicLong()
            // offspring = null: an evaluation task (no variation); else whether it is a crossover task
            suspend fun timed(offspring: Boolean?, block: suspend () -> List<EvaluationResult>): List<EvaluationResult> {
                val t0 = System.nanoTime()
                val slot = VariationTiming.reset()
                try {
                    val results = block()
                    val nanos = System.nanoTime() - t0
                    record(results)
                    if (offspring != null) results.forEach { variationOf(it, offspring, slot, nanos) }
                    return results
                } finally {
                    val d = System.nanoTime() - t0
                    busy.addAndGet(d); longest.accumulateAndGet(d, ::maxOf)
                }
            }
            val mutations = batch.tasks.map { task ->
                async(pool) { timed(false) { inner.executeNodeBatches(listOf(NodeBatch(batch.nodeId, listOf(task), emptyList(), emptyList()))) } }
            }
            val crossovers = batch.crossoverTasks.map { task ->
                async(pool) {
                    timed(true) {
                        inner.executeNodeBatches(listOf(NodeBatch(batch.nodeId, emptyList(), emptyList(), emptyList(), crossoverTasks = listOf(task))))
                    }
                }
            }
            val evaluations = batch.evaluationTasks.map { task ->
                async(pool) { timed(null) { inner.executeNodeBatches(listOf(NodeBatch(batch.nodeId, emptyList(), listOf(task), emptyList()))) } }
            }
            val done = mutations.awaitAll().flatten() + crossovers.awaitAll().flatten() + evaluations.awaitAll().flatten()
            if (timing) println("timing ${batch.nodeId}: ${batch.tasks.size + batch.crossoverTasks.size + batch.evaluationTasks.size} tasks, " +
                "wall ${(System.nanoTime() - started) / 1_000_000} ms, busy ${busy.get() / 1_000_000} ms, longest ${longest.get() / 1_000_000} ms, " +
                ArchExternalCalls.takeStats())
            if (batch.discards.isNotEmpty() || batch.replicas.isNotEmpty()) {
                inner.executeNodeBatches(listOf(NodeBatch(batch.nodeId, emptyList(), emptyList(), batch.discards, replicas = batch.replicas)))
                batch.discards.forEach { recorded.remove(it); variations.remove(it) }
            }
            results += done
        }
        results
    }

    override suspend fun getSolutionData(ref: WorkerSolutionRef): SerializedModel = inner.getSolutionData(ref)

    override suspend fun resetBatch() {
        recorded.clear()
        variations.clear()
        inner.resetBatch()
    }

    override suspend fun cleanup() {
        inner.cleanup()
        pool.close()
    }

    override fun getNodeIds(): Set<String> = inner.getNodeIds()
}
