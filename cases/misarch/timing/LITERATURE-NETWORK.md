# Literature values: network, sidecar, broker, commit latency

Purpose: defaults and sensitivity range for the parts of the MiSArch deployment that the
single-host dev VM cannot measure (everything "between" services). Sources as of October 2026.

Labels: **[M]** measured in a paper or independent benchmark, **[V]** vendor docs or vendor
benchmark, **[C]** read from source code (authoritative for defaults), **[E]** my estimate.
sockperf ping-pong reports **one-way = RTT/2**; netperf TCP_RR and ping report **RTT**.

Important for use: the dev-VM measurements already include loopback TCP, the daprd sidecar
CPU/latency (daprd 1.15.14 runs per service in compose), Redis and PostgreSQL on the VM's
own disk. What they lack is the **wire/CNI part** (cross-node, cross-zone) and any storage
difference. Do not add sidecar or commit latency a second time unless the model strips
them out of the measured demands.

## 1. Pod-to-pod / VM-to-VM network latency

| Value | Unit | Stat | Setup | Source | Kind |
|---|---|---|---|---|---|
| 7.6 / 17.3 | µs one-way | mean | same node, pod-to-pod, with / without eBPF socket bypass; bare metal, 10 GbE ConnectX-5, k8s 1.28, sockperf | Spiderpool docs "IO performance" (2023), github.com/spidernet-io/spiderpool/blob/main/docs/concepts/io-performance.md | M (project benchmark) |
| 32.2 | µs one-way | mean | node-to-node baseline, same setup | same | M |
| 29.1 / 51.3 | µs one-way | mean | cross-node pod IP, Cilium 1.14 eBPF / Calico 3.26 iptables, no tunnel | same | M |
| 30.2 / 51.9 | µs one-way | mean | cross-node **Service ClusterIP**, Cilium / Calico | same | M |
| 36.8 vs 27.7 | µs one-way | mean | ClusterIP via kube-proxy (iptables) vs eBPF service LB (Spiderpool) | same; so kube-proxy/VIP adds ~1-9 µs | M |
| 47.6k vs 10-17.6k | req/s | TCP_RR 1 stream | node-to-node vs pod-to-pod (Calico/Cilium): ≈21 µs vs 57-100 µs RTT | same | M |
| qualitative | - | - | Cilium lowest, Calico-with-policy highest pod RTT; overlay (VXLAN/IPIP) adds cost; 25 GbE, netperf RR 1 B | Qi, Kulkarni, Ramakrishnan, "Assessing Container Network Interface Plugins", IEEE TNSM 18(1), 2021 (numbers only in figures) | M |
| qualitative | - | - | eBPF host-routing ≈ node-to-node RR rate; iptables adds per-connection cost | Cilium docs "CNI Performance Benchmark" (Cilium 1.9, 100 GbE, kernel 5.10), docs.cilium.io/en/latest/operations/performance/benchmark/ | V |
| 24-25 (p99 28-31) | µs one-way | p50 | AWS **same AZ**, c7i.large, ENA, no placement group, sockperf TCP | Classmethod DevelopersIO "Tokyo/Osaka AZ latency" (2026-07), dev.classmethod.jp/articles/tokyo-osaka-az-latency/ | M (blog) |
| 129-389 (p99 238-517) | µs one-way | p50 | AWS **cross-AZ** Osaka pairs | same | M (blog) |
| 604-845 (p99 670-911) | µs one-way | p50 | AWS **cross-AZ** Tokyo pairs; netperf TCP_RR mean RTT 1.15-1.69 ms | same | M (blog) |
| 300 µs intra-AZ, 1.5 ms cross-AZ | RTT | p50 (assumed) | worked example, ping on t4g.small in us-east-1/us-west-2/eu-west-1; "single digit ms" between AZs | AWS Architecture Blog, M. Haken, "Improving performance and reducing cost using AZ affinity" (2021, upd. 2025) | V |
| < ~2 | ms RTT | target | Azure inter-zone network links | Microsoft Learn "What are Azure availability zones" (2026) | V |
| < 5 | ms | p95 | GCP zones within a region (old GCP docs, quoted secondhand in books; current docs only "low-latency") | GCP regions-zones docs / secondary | V (weak) |
| 500 | µs RTT | typical | "round trip within same datacenter" | J. Dean, "Designs, Lessons and Advice from Building Large Distributed Systems", LADIS 2009 | V (classic, dated) |
| ~200 / 30 | µs | typical | Redis client over 1 GbE / Unix socket | redis.io "Diagnosing latency issues" | V |

## 2. Dapr sidecar (and sidecar proxies in general)

| Value | Unit | Stat | Setup | Source | Kind |
|---|---|---|---|---|---|
| +1.40 / +2.10 | ms | p90 / p99 | service invocation app→sidecar→sidecar→app and back (**2 sidecars, round trip**), Dapr v1.0, 3 nodes 4 cores/8 GB, cross-node, 1000 rps, 1 KB, sidecar 0.5 vCPU limit, mTLS on, tracing 10 %; baseline direct without mTLS | Dapr docs "Service invocation performance" (v1.0 summary, still the published page in v1.11-v1.15) | V |
| 0.48 vCPU, 23 MB | per 1000 rps | - | per sidecar, same test (≈0.48 ms CPU per request per sidecar) | same | V |
| +1.20 / +2.50 | ms | p90 / p99 | same test, Dapr v1.12; sidecar 0.45 vCPU per 1000 rps | dapr/docs PR #4896 "Perf benchmarks" (2025, **unmerged**) | V |
| +0.49 HTTP / +0.64 gRPC | ms | p90 | **pub/sub publish** via Dapr vs publish directly to broker; Kafka (3 replicas), Dapr v1.12, 1000 rps, 1 KB, 0.5 vCPU sidecar | same PR | V |
| +1.21 HTTP / +1.91 gRPC | ms | p99 | same | same | V |
| +0.75 / +1.52 | ms | p90 / p99 | state GET via Dapr vs direct (PostgreSQL) | same PR | V |
| 4-33 m sidecar CPU at 1000 it/s | mCPU | point sample | Dapr v1.19, AKS 3× D2s_v6; latency only in charts | Dapr docs "Performance results" (current) | V (CPU samples look unreliable) |
| 41 / 165 / 192 | µs | mean | added latency of **one** Envoy sidecar (inbound+outbound), TCP / HTTP / gRPC mode; 100 B, 30k rps, Xeon Gold 6142, CloudLab | Zhu et al., "Dissecting Overheads of Service Mesh Sidecars", SoCC 2023, Table 2 | M |
| +27-269 % latency, +42-163 % CPU | - | end-to-end | Hotel Reservation / Online Boutique with Envoy mesh | same | M |
| 0.20 vCPU, 60 MB | per 1000 rps | - | one Istio sidecar, 1 KB, mTLS; latency only in charts | Istio docs "Performance and scalability" (Istio 1.24) | V |

## 3. Dapr pub/sub on Redis Streams

Delivery mechanics (read from source, components-contrib `pubsub/redis/redis.go`,
`common/component/redis/redis.go`, identical in release-1.15 and main) **[C]**:

- One `XREADGROUP GROUP <consumerID> <consumerID> COUNT <queueDepth> BLOCK <readTimeout> STREAMS <topic> >`
  loop per subscribed topic. `readTimeout` default 0 → go-redis sends `BLOCK 0` = block until data:
  **push-like, no poll interval**. Redis serves blocked readers in the same event-loop cycle as
  the `XADD` (redis.io Streams docs, "How serving blocked consumers works").
- Messages go into one buffered channel (`queueDepth`, default **100**) shared by the component;
  **`concurrency` default 10** worker goroutines per component per sidecar. Each worker calls the
  app handler synchronously (HTTP POST to the app), then `XACK`. So ≤10 in-flight deliveries per
  replica; more replicas = competing consumers in the same group (consumerID defaults to app-id).
- Redelivery: every `redeliverInterval` (**15 s**) `XPENDING`/`XCLAIM` messages pending longer than
  `processingTimeout` (**60 s**, also handler timeout). A failed/NACKed message is retried after
  ≥60 s (plus Dapr resiliency policy, if any). Keep-alive `XCLAIM` every processingTimeout/2.
- App side: `--app-max-concurrency` default **-1 (unlimited)** (Dapr arguments/annotations docs) **[V]**.
- MiSArch `pubsub.yaml` (misarch-kotlin/deploy/compose/.dapr/components) sets only host/password/TLS,
  so all defaults above apply.

| Value | Unit | Stat | Setup | Source | Kind |
|---|---|---|---|---|---|
| 74 % < 1 ms, 99.9 % ≤ 2 ms | ms | distribution | Redis Streams XADD → consumer-group reader, Ruby clients, COUNT 10000, "very slow" old machine | redis.io Streams docs, "Latency tests results" | V |
| sub-µs | - | - | Redis command processing time itself | redis.io "Diagnosing latency issues" | V |
| defaults | - | - | redeliverInterval 15s, processingTimeout 60s, queueDepth 100, concurrency 10, readTimeout 0s (blocking) | Dapr docs "Redis Streams" pub/sub component + source | V + C |
| no published number | - | - | Dapr end-to-end publish→subscriber with Redis | - | - |

## 4. PostgreSQL commit (synchronous_commit = on)

`synchronous_commit` default `on`: commit waits for local WAL flush; `wal_sync_method` default
`fdatasync` on Linux; `commit_delay` 0 (PostgreSQL docs, runtime-config-wal) **[V]**. So commit
latency ≈ WAL write + flush latency of the volume (+ app→DB RTT).

| Value | Unit | Stat | Setup | Source | Kind |
|---|---|---|---|---|---|
| 9.8-29 | µs | mean | fdatasync after 16 KB O_DIRECT write, local enterprise NVMe with PLP (Hetzner D7-P5520; GCP c3d local SSD) | M. Callaghan, "SSDs, power loss protection and fsync latency", Small Datum, 2026-01 | M |
| 2,783-2,974 | µs | mean | same, consumer NVMe **without** PLP (Samsung 990 Pro) | same | M |
| 46-47 (fsync 635-738) | µs | mean | GCP Hyperdisk Balanced 50k IOPS, sync call only (write time not included) | same | M |
| < 500 | µs | avg | EBS io2 Block Express, 16 KiB I/O | AWS EBS docs "volume types" | V |
| 1.67 vs 0.39 | ms | avg disk latency | PostgreSQL 16.5 HammerDB TPC-C stress at 80k IOPS, r5b.24xlarge, gp3 RAID-0 ×8 vs io2 BE ×2 | AWS Storage Blog, Mula & Singprasong (2025-05) | V |
| 3.69 (p99 5.8) | ms | p50 | fio randwrite 4k + fsync, iodepth 1, **gp2** 1600 GB, t2.2xlarge | J. Cartwright, "Can IOPS be estimated from fsync?" (2025-03) | M (blog) |
| ~250 vs ~50 | µs | typical RTT | EBS vs local NVMe I/O round trip | PlanetScale blog, B. Dicken, "IO devices and latency" (2025-03) | V |
| ~1 ms vs µs | - | typical | prod workload I/O latency on network volumes vs Metal NVMe | PlanetScale "Metal" launch blog (2025) | V |

## 5. Production RPC latency (plausibility)

| Value | Stat | Setup | Source | Kind |
|---|---|---|---|---|
| 90 % of methods: P1 ≤ 657 µs; most RPCs complete in 100s of µs | per-method | Google fleet, 23 months | Seemakhupt et al., "A Cloud-Scale Characterization of Remote Procedure Calls", SOSP 2023 | M |
| median RPC tax (queue + stack + wire) = 8.6 % of completion time | median method | same | same | M |
| half of methods: median queuing < 360 µs, median stack+network < 398 µs | median | same (includes WAN) | same | M |
| > 99.5 % of methods have P99 ≥ 1 ms | P99 | same | same | M |
| Envoy adds up to 100 ms for 25 % of call graphs | - | Alibaba traces replayed through MeshInsight model | Zhu et al., SoCC 2023 | M (model) |

## Recommended model defaults

One-way values per message unless stated; RTT = 2 × one-way. "Default" is a single-zone,
multi-node cluster with a non-eBPF CNI (Calico/Flannel class) on cloud VMs.

| Parameter | Default | Low | High | Basis |
|---|---|---|---|---|
| Network one-way, same node (pod→pod over veth) | 0.02 ms | 0.005 ms | 0.05 ms | M (Spiderpool 7.6-17 µs) + E |
| Network one-way, cross node, same zone | 0.10 ms | 0.03 ms | 0.25 ms | M (25-51 µs bare metal/VM) + V (AWS 300 µs RTT) + E for cloud overlay/HTTP stack |
| Network one-way, cross zone | 0.50 ms | 0.15 ms | 1.0 ms | M (AWS 0.13-0.85 ms) + V (Azure < 2 ms RTT) |
| kube-proxy / ClusterIP VIP extra | 0.005 ms | 0 | 0.01 ms | M (Spiderpool) |
| Dapr sidecar added latency, per sidecar traversal of a request+response (invocation) | 0.5 ms | 0.15 ms | 1.0 ms | V (2 sidecars +1.2-1.4 ms p90) + M (Envoy 0.17-0.19 ms) |
| Dapr publish added latency (app→sidecar→broker ack) | 0.4 ms | 0.15 ms | 1.0 ms | V (+0.49 ms p90 HTTP, Kafka) |
| Dapr subscriber-side delivery (sidecar→app POST, then XACK) | 0.4 ms | 0.15 ms | 1.0 ms | E (mirror of publish path) |
| Redis Streams XADD → blocked XREADGROUP wake-up, excl. sidecars and wire | 0.05 ms | 0.01 ms | 1.0 ms | V (redis.io) + E |
| End-to-end event app→app via Dapr+Redis, cross node | ≈1.2 ms | 0.5 ms | 5 ms | E (sum of above) |
| Dapr consumer concurrency per replica (Redis component) | 10 workers, queueDepth 100, BLOCK 0 | - | - | C |
| Redelivery after handler failure | ≥ 60 s (checked every 15 s) | - | - | C |
| DB commit (WAL fdatasync), cloud block storage (gp3 / PD / Hyperdisk) | 1.0 ms | 0.3 ms (io2/Hyperdisk) | 4 ms (gp2 / throttled) | V + M |
| DB commit, local enterprise NVMe | 0.05 ms | 0.01 ms | 0.1 ms | M |
| App→DB network | as pod network (cross node default 0.10 ms one-way) | | | M + E |

## Sensitivity factors (multiply the unmeasured "middle")

Apply the factor to network one-way delays (and, if modelled separately, the sidecar/broker
add-ons). DB commit is measured on the VM; vary it separately if the target storage differs.

| Factor | Cross-node one-way | Sidecar (per traversal) | E2E event | Interpretation |
|---|---|---|---|---|
| x0 | 0 | 0 | ~0 extra | dev VM as measured (loopback only); lower bound |
| x1 | 0.10 ms | 0.5 ms | ~1.2 ms | single-zone cluster, typical CNI, default Dapr (mTLS, 10 % tracing) |
| x3 | 0.30 ms | 1.5 ms | ~3.6 ms | services spread over AZs in a "fast" region (Osaka-like 0.13-0.39 ms), or CPU-limited sidecars at ~p99 |
| x10 | 1.0 ms | 5 ms | ~12 ms | pessimistic: cross-AZ in a slow region (Tokyo 0.6-0.85 ms one-way, RTT ~1.2-1.7 ms) plus throttled sidecars; upper plausibility bound, still under Google fleet P99 (≥1 ms for >99.5 % of methods) |

Takeaway: at x1 the per-hop middle (~0.2 ms RTT network + ~0.5 ms sidecar) is small next to
ms-scale service demands. It only matters for long synchronous call chains or event cascades,
and for cross-zone placement (x3-x10).
