use anyhow::{Context, Result};
use aya::{
    maps::{AsyncPerfEventArray, Array, HashMap as AyaHashMap},
    programs::{tc, SchedClassifier, TcAttachType},
    util::online_cpus,
    Ebpf,
};
use aya_log::EbpfLogger;
use bytes::BytesMut;
use log::{info, warn};
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::signal;
use clap::Parser;

use kprobe_userspace::{
    cert_store::CertStore,
    policy_cache::PolicyCache,
    pod_watcher::{PodEvent, PodWatcher},
    sigil_client::SigilClient,
    verdict_sync::VerdictSync,
};

// ─── CLI ─────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "kprobe-loader", about = "MeshLite eBPF enforcer agent")]
struct Cli {
    /// Network interface to attach TC egress hook to.
    #[arg(long, default_value = "eth0")]
    iface: String,

    /// Path to the compiled eBPF object file.
    #[arg(long, default_value = "/app/kprobe-ebpf")]
    ebpf_path: String,

    /// Sigil gRPC address.
    #[arg(long, default_value = "sigil.meshlite-system.svc.cluster.local:8443")]
    sigil_addr: String,

    /// Kubernetes node name (falls back to $NODE_NAME env var).
    #[arg(long, env = "NODE_NAME", default_value = "unknown-node")]
    node_id: String,

    /// Cluster identifier.
    #[arg(long, default_value = "dev")]
    cluster_id: String,
}

// ─── Shared type ─────────────────────────────────────────────────────────────
//
// Must match the #[repr(C)] PacketLog declared in kprobe-ebpf/src/main.rs exactly.

#[repr(C)]
#[derive(Copy, Clone)]
struct PacketLog {
    src_ip:   u32, // network byte order
    dst_ip:   u32, // network byte order
    src_port: u16, // host byte order
    dst_port: u16, // host byte order
    proto:    u8,  // 6 = TCP, 17 = UDP
    verdict:  u8,  // 0 = ALLOW, 1 = DENY
}

// ─── Entry point ─────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    // Install ring as the process-level rustls CryptoProvider before any TLS operations.
    // Without this, rustls panics when both ring and aws-lc-rs features are present.
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install ring as the default rustls CryptoProvider");

    env_logger::init();

    let cli = Cli::parse();

    info!("[kprobe] Loading eBPF object from: {}", cli.ebpf_path);
    info!("[kprobe] Attaching to interface:   {}", cli.iface);
    info!("[kprobe] Node: {}  Cluster: {}  Sigil: {}",
        cli.node_id, cli.cluster_id, cli.sigil_addr);

    // ── 1. Load the eBPF object ───────────────────────────────────────────────
    let mut ebpf = Ebpf::load_file(&cli.ebpf_path)
        .with_context(|| format!("Failed to load eBPF object '{}'", cli.ebpf_path))?;

    if let Err(e) = EbpfLogger::init(&mut ebpf) {
        warn!("[kprobe] eBPF logger unavailable (non-fatal): {}", e);
    }

    // ── 2. Add clsact qdisc ───────────────────────────────────────────────────
    if let Err(e) = tc::qdisc_add_clsact(&cli.iface) {
        let msg = format!("{}", e);
        if !msg.contains("17") {
            return Err(e).context("Failed to add clsact qdisc to interface")?;
        }
        info!("[kprobe] clsact qdisc already present on {} — continuing", cli.iface);
    }

    // ── 4. Open shared eBPF maps ──────────────────────────────────────────────
    let verdict_map = Arc::new(Mutex::new(
        AyaHashMap::<_, kprobe_userspace::verdict_sync::PacketKey, u8>::try_from(
            ebpf.take_map("VERDICT_MAP")
                .context("Map 'VERDICT_MAP' not found in eBPF object")?,
        )
        .context("Failed to open VERDICT_MAP as HashMap")?,
    ));

    let policy_flags = Arc::new(Mutex::new(
        Array::<_, u32>::try_from(
            ebpf.take_map("POLICY_FLAGS")
                .context("Map 'POLICY_FLAGS' not found in eBPF object")?,
        )
        .context("Failed to open POLICY_FLAGS as Array")?,
    ));

    // Start with allow-all so kprobe can bootstrap its connections to the
    // k8s API and Sigil. VerdictSync overwrites this once a PolicyBundle arrives.
    {
        let mut pf = policy_flags.lock().unwrap();
        pf.set(0, 1u32, 0).context("Failed to initialise POLICY_FLAGS[0] to allow-all")?;
    }
    info!("[kprobe] POLICY_FLAGS[0] set to allow-all (bootstrap mode)");

    // ── 3. Load and attach TC classifier ─────────────────────────────────────
    let program: &mut SchedClassifier = ebpf
        .program_mut("kprobe_egress")
        .context("Program 'kprobe_egress' not found in eBPF object")?
        .try_into()
        .context("'kprobe_egress' is not a SchedClassifier program")?;
    program.load().context("Kernel rejected the eBPF program (verifier error)")?;
    program.attach(&cli.iface, TcAttachType::Egress)
        .context("Failed to attach TC classifier to egress hook")?;

    info!("[kprobe] eBPF program loaded on {} — intercepting pod-to-pod traffic", cli.iface);

    // ── 5. Set up shared state ────────────────────────────────────────────────
    //
    // CertStore is seeded by the first CertBundle pushed by Sigil; the leaf
    // cert and private key both come from Sigil (no local key generation needed).
    let cert_store   = Arc::new(Mutex::new(CertStore::new()));
    let policy_cache = Arc::new(Mutex::new(PolicyCache::new()));

    // sync_tx fires whenever CertStore or PolicyCache is updated,
    // triggering VerdictSync to rebuild VERDICT_MAP.
    let (sync_tx, mut sync_rx) = mpsc::channel::<()>(32);

    // ── 6. Spawn PodWatcher task ──────────────────────────────────────────────
    let (pod_tx, mut pod_rx) = mpsc::channel::<PodEvent>(32);
    let pod_watcher  = PodWatcher::new(cli.node_id.clone());
    let pod_snapshot = pod_watcher.snapshot_handle();
    tokio::spawn(pod_watcher.run(pod_tx));

    // Forward pod changes into the sync channel.
    let sync_tx_pod = sync_tx.clone();
    tokio::spawn(async move {
        while pod_rx.recv().await.is_some() {
            let _ = sync_tx_pod.send(()).await;
        }
    });

    // ── 7. Spawn SigilClient task ─────────────────────────────────────────────
    let sigil = SigilClient::new(
        cli.sigil_addr.clone(),
        cli.node_id.clone(),
        cli.cluster_id.clone(),
        Arc::clone(&pod_snapshot),
    );
    let cert_store_sig   = Arc::clone(&cert_store);
    let policy_cache_sig = Arc::clone(&policy_cache);
    let sync_tx_sig      = sync_tx.clone();
    tokio::spawn(async move {
        sigil.run(cert_store_sig, policy_cache_sig, sync_tx_sig).await;
    });

    // ── 8. Spawn VerdictSync task ─────────────────────────────────────────────
    let verdict_sync     = VerdictSync::new(Arc::clone(&verdict_map), Arc::clone(&policy_flags));
    let policy_cache_vs  = Arc::clone(&policy_cache);
    let pod_snapshot_vs  = Arc::clone(&pod_snapshot);
    tokio::spawn(async move {
        while sync_rx.recv().await.is_some() {
            let policy = policy_cache_vs.lock().unwrap().clone();
            let pods   = pod_snapshot_vs.lock().unwrap().clone();
            verdict_sync.sync(&policy, &pods);
        }
    });

    // ── 9. Open perf event array and spawn per-CPU readers ───────────────────
    let mut perf_array = AsyncPerfEventArray::try_from(
        ebpf.take_map("PACKET_EVENTS")
            .context("Map 'PACKET_EVENTS' not found in eBPF object")?,
    )
    .context("Failed to open AsyncPerfEventArray")?;

    let cpus = online_cpus()
        .map_err(|e| anyhow::anyhow!("Failed to enumerate online CPUs: {:?}", e))?;

    for cpu_id in cpus {
        let mut buf = perf_array
            .open(cpu_id, None)
            .with_context(|| format!("Failed to open perf buffer for CPU {}", cpu_id))?;

        tokio::spawn(async move {
            let mut buffers: Vec<BytesMut> = (0..10)
                .map(|_| BytesMut::with_capacity(256))
                .collect();

            loop {
                let events = match buf.read_events(&mut buffers).await {
                    Ok(e) => e,
                    Err(e) => {
                        warn!("[kprobe] CPU {} perf buffer read error: {} — stopping reader",
                            cpu_id, e);
                        break;
                    }
                };

                for slot in buffers.iter().take(events.read) {
                    if slot.len() < std::mem::size_of::<PacketLog>() {
                        warn!("[kprobe] Received undersized perf record, skipping");
                        continue;
                    }

                    // SAFETY: layout is #[repr(C)] and buffer length is verified above.
                    let log: PacketLog = unsafe {
                        (slot.as_ptr() as *const PacketLog).read_unaligned()
                    };

                    let src    = Ipv4Addr::from(u32::from_be(log.src_ip));
                    let dst    = Ipv4Addr::from(u32::from_be(log.dst_ip));
                    let proto  = match log.proto {
                        6  => "TCP",
                        17 => "UDP",
                        p  => { warn!("[kprobe] Unknown proto {}", p); continue; }
                    };
                    let verdict = if log.verdict == 0 { "ALLOW" } else { "DENY" };

                    // Only log pod-to-pod traffic (10.244.0.0/16).
                    // Node traffic (172.18.x.x kubelet heartbeats) generates
                    // ~200 k+ lines/hour, overflowing the k8s log buffer and
                    // evicting startup/state-machine messages.
                    let s = src.octets();
                    let d = dst.octets();
                    if (s[0] == 10 && s[1] == 244) || (d[0] == 10 && d[1] == 244) {
                        println!(
                            "[INTERCEPT] src={}:{} dst={}:{} proto={} verdict={}",
                            src, log.src_port, dst, log.dst_port, proto, verdict
                        );
                    }
                }
            }
        });
    }

    info!("[kprobe] Listening — press Ctrl+C to stop");

    // ── 10. Block until Ctrl+C / SIGTERM ─────────────────────────────────────
    signal::ctrl_c().await?;
    info!("[kprobe] Shutting down — eBPF program unloaded");
    Ok(())
}

