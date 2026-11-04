package com.mdeo.optimizer

import com.mdeo.common.transport.SessionConnection
import com.mdeo.script.compiler.CompiledProgram
import com.mdeo.script.external.SessionDispatcher
import com.mdeo.script.runtime.ExternalCallDispatcher
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.math.BigInteger
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64
import java.util.UUID

/**
 * External-function dispatchers for the headless harness (see ArchHarnessTest).
 *
 * The seam: [ExternalCallDispatcher] is what a compiled script calls for every function with an
 * external implementation, and [ScriptGuidanceFunction][com.mdeo.optimizer.guidance.ScriptGuidanceFunction]
 * takes one. The worker builds it with `ExternalSessions.createDispatcher`, i.e. a
 * [SessionDispatcher] whose sessions the backend resolves (`SessionResolver`, run token → session
 * URL + RS256 session token). Headless there is no backend, so this builds the same
 * [SessionDispatcher] with a resolver of its own:
 *
 * - it generates an RSA key and serves it as `<base>/api/.well-known/jwks.json` on 127.0.0.1
 *   (the plugin service verifies session tokens against `<BACKEND_API_URL>/.well-known/jwks.json`);
 * - it signs session tokens with exactly the claims a plugin service checks (issuer
 *   `mdeo-platform`, scope `plugin:session:connect`, target `contrib:<id>`, session name,
 *   projectId, executionId);
 * - the session URL is `ws://<host>:<port>/ws/sessions/contrib/<id>/<session>` (website/docs/develop/sessions.md).
 *
 * Everything after that — CBOR protocol, model upload, records — is the platform's own
 * [SessionDispatcher] / ScriptFunctionsClient, unchanged.
 *
 * ARCH_EXTERNAL:
 *   unset                      ExternalCallDispatcher.UNSUPPORTED (static scripts only)
 *   spawn:<command>            start the plugin service (e.g. `spawn:/path/palladio-sim-service serve`) with PORT=ARCH_PLUGIN_PORT (3121) and
 *                              BACKEND_API_URL pointing at the harness's JWKS; stopped at the end
 *   connect:<host>:<port>      use a running plugin service that was started with
 *                              BACKEND_API_URL=http://127.0.0.1:<ARCH_JWKS_PORT>/api
 * ARCH_JWKS_PORT (default 18099) is where the JWKS is served. ARCH_PLUGINS=k (spawn only) starts k
 * services (ports ARCH_PLUGIN_PORT + 0, 2, 4, ...) and spreads the threads' sessions over them.
 */
object ArchExternalCalls {

    private var jwks: HttpServer? = null
    private val services = mutableListOf<Process>()

    /** Plugin calls made and their total time (ARCH_TIMING), since the last [takeStats]. */
    private val calls = java.util.concurrent.atomic.AtomicLong()
    private val callNanos = java.util.concurrent.atomic.AtomicLong()
    private val perCall = if (System.getenv("ARCH_TIMING_CALLS") == "1") java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicLong>() else null
    private val perCallCount = if (perCall != null) java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicLong>() else null
    fun callTable(): String = perCall?.entries?.sortedByDescending { it.value.get() }?.joinToString("\n") {
        "  ${it.key}: ${perCallCount!![it.key]?.get()} calls, ${it.value.get() / 1_000_000} ms"
    } ?: ""
    fun takeStats(): String = "${calls.getAndSet(0)} plugin calls, ${callNanos.getAndSet(0) / 1_000_000} ms in them"
    private val keys: KeyPair by lazy { KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.genKeyPair() }
    private val kid = "arch-harness-" + UUID.randomUUID().toString().take(8)
    private val executionId = UUID.randomUUID().toString()

    /** Whether ARCH_EXTERNAL asks for plugin calls. */
    fun enabled(): Boolean = System.getenv("ARCH_EXTERNAL") != null

    /** The dispatcher for [program]'s external calls, per ARCH_EXTERNAL. */
    fun dispatcher(program: CompiledProgram, logDir: File): ExternalCallDispatcher {
        val spec = System.getenv("ARCH_EXTERNAL") ?: return ExternalCallDispatcher.UNSUPPORTED
        if (program.externalCalls.isEmpty()) return ExternalCallDispatcher.UNSUPPORTED
        val jwksPort = (System.getenv("ARCH_JWKS_PORT") ?: "18099").toInt()
        startJwks(jwksPort)
        // ARCH_PLUGINS (default 1) plugin services: ports ARCH_PLUGIN_PORT, +2, +4, ... (the odd
        // ports stay free for run-domain.sh's manifest probe); the evaluation threads are spread
        // over them round-robin (one session per thread on its service)
        val services = (System.getenv("ARCH_PLUGINS") ?: "1").toInt()
        val endpoints: List<Pair<String, Int>> = when {
            spec.startsWith("spawn:") -> {
                val base = (System.getenv("ARCH_PLUGIN_PORT") ?: "3121").toInt()
                (0 until services).map { i ->
                    val port = base + 2 * i
                    spawn(spec.removePrefix("spawn:"), port, jwksPort, logDir, if (i == 0) "plugin-service.log" else "plugin-service-$i.log")
                    "127.0.0.1" to port
                }
            }
            spec.startsWith("connect:") -> {
                val (h, p) = spec.removePrefix("connect:").split(":")
                listOf(h to p.toInt())
            }
            else -> error("ARCH_EXTERNAL=$spec: expected spawn:<binary> or connect:<host>:<port>")
        }
        val nextEndpoint = java.util.concurrent.atomic.AtomicInteger()
        // one session per thread, as the worker does (ExternalSessions.createDispatcher perThread)
        fun newDispatcher(): SessionDispatcher {
            val (host, port) = endpoints[Math.floorMod(nextEndpoint.getAndIncrement(), endpoints.size)]
            return SessionDispatcher(program.externalCalls, program.contributedClasses) { contribution, session ->
                SessionConnection(
                    url = "ws://$host:$port/ws/sessions/contrib/$contribution/$session",
                    protocol = "script-functions",
                    versions = listOf(1),
                    token = token(contribution, session),
                    expiresAt = System.currentTimeMillis() / 1000 + 3600
                )
            }
        }
        val local = ThreadLocal.withInitial { newDispatcher() }
        return object : ExternalCallDispatcher {
            override fun call(callId: String, arguments: Array<Any?>, model: com.mdeo.metamodel.Model?, classLoader: ClassLoader): Any? {
                val t0 = System.nanoTime()
                try { return call0(callId, arguments, model, classLoader) } finally {
                    calls.incrementAndGet(); callNanos.addAndGet(System.nanoTime() - t0)
                    if (perCall != null) perCall.computeIfAbsent(callId) { java.util.concurrent.atomic.AtomicLong() }.addAndGet(System.nanoTime() - t0)
                    perCallCount?.computeIfAbsent(callId) { java.util.concurrent.atomic.AtomicLong() }?.incrementAndGet()
                }
            }
            fun call0(callId: String, arguments: Array<Any?>, model: com.mdeo.metamodel.Model?, classLoader: ClassLoader): Any? =
                try {
                    local.get().call(callId, arguments, model, classLoader)
                } catch (e: com.mdeo.script.external.ExternalCallException) {
                    // a session the service dropped (e.g. after a long pause): open a fresh one once
                    System.err.println("external call failed (${e.message}); retrying on a new session")
                    runCatching { local.get().close() }
                    local.set(newDispatcher())
                    local.get().call(callId, arguments, model, classLoader)
                }
        }
    }

    fun close() {
        if (perCall != null) println("plugin calls by function:\n" + callTable())
        services.forEach { it.destroy() }
        services.forEach { it.waitFor() }
        services.clear()
        jwks?.stop(0)
        jwks = null
    }

    private fun b64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun unsigned(n: BigInteger): ByteArray {
        val bytes = n.toByteArray()
        return if (bytes.size > 1 && bytes[0] == 0.toByte()) bytes.copyOfRange(1, bytes.size) else bytes
    }

    private fun startJwks(port: Int) {
        if (jwks != null) return
        val pub = keys.public as RSAPublicKey
        val body = """{"keys":[{"kty":"RSA","kid":"$kid","use":"sig","alg":"RS256",""" +
            """"n":"${b64(unsigned(pub.modulus))}","e":"${b64(unsigned(pub.publicExponent))}"}]}"""
        jwks = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0).apply {
            createContext("/api/.well-known/jwks.json") { exchange ->
                val bytes = body.toByteArray()
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            start()
        }
    }

    private fun token(contribution: String, session: String): String {
        val now = System.currentTimeMillis() / 1000
        val header = """{"alg":"RS256","typ":"JWT","kid":"$kid"}"""
        val payload = """{"iss":"mdeo-platform","iat":$now,"exp":${now + 3600},""" +
            """"scope":["plugin:session:connect"],"target":"contrib:$contribution","session":"$session",""" +
            """"projectId":"arch-headless","executionId":"$executionId"}"""
        val signingInput = b64(header.toByteArray()) + "." + b64(payload.toByteArray())
        val signature = Signature.getInstance("SHA256withRSA").apply {
            initSign(keys.private)
            update(signingInput.toByteArray())
        }.sign()
        return signingInput + "." + b64(signature)
    }

    private fun spawn(binary: String, port: Int, jwksPort: Int, logDir: File, logName: String) {
        val log = File(logDir, logName)
        val builder = ProcessBuilder(binary.split(" ").filter { it.isNotBlank() })
            .redirectErrorStream(true)
            .redirectOutput(log)
        builder.environment()["PORT"] = port.toString()
        builder.environment()["HOST"] = "127.0.0.1"
        builder.environment()["BACKEND_API_URL"] = "http://127.0.0.1:$jwksPort/api"
        // the plugin's malloc arenas: MALLOC_ARENA_MAX=2 (the JVM's setting, inherited)
        // serialises its threads' allocations; ARCH_PLUGIN_ARENAS=<n> sets it for the plugin, 0 = glibc's default
        System.getenv("ARCH_PLUGIN_ARENAS")?.let { n ->
            if (n == "0") builder.environment().remove("MALLOC_ARENA_MAX") else builder.environment()["MALLOC_ARENA_MAX"] = n
        }
        val service = builder.start()
        services += service
        Runtime.getRuntime().addShutdownHook(Thread { service.destroy() })
        val deadline = System.currentTimeMillis() + 60_000
        while (System.currentTimeMillis() < deadline) {
            val up = runCatching { Socket("127.0.0.1", port).close() }.isSuccess
            if (up) return
            if (!service.isAlive) error("the plugin service exited: see $log")
            Thread.sleep(200)
        }
        error("the plugin service did not listen on $port within 60 s: see $log")
    }
}
