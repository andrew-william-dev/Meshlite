use anyhow::{Context, Result};
use aya::{
    maps::AsyncPerfEventArray,
    programs::{tc, SchedClassifier, TcAttachType},
    util::online_cpus,
    Ebpf,
};
use aya_log::EbpfLogger;
use bytes::BytesMut;
use log::{info, warn};
use std::net::Ipv4Addr;
use tokio::signal;

// ─── Shared type ─────────────────────────────────────────────────────────────
//
// Must match the #[repr(C)] PacketLog declared in kprobe-ebpf/src/main.rs exactly.
// Field order, types, and padding byte are identical.

#[repr(C)]
#[derive(Copy, Clone)]
struct PacketLog {
    src_ip:   u32, // network byte order
    dst_ip:   u32, // network byte order
    src_port: u16, // host byte order (converted in eBPF program)
    dst_port: u16, // host byte order (converted in eBPF program)
    proto:    u8,  // 6 = TCP, 17 = UDP
    _pad:     u8,
}

// ─── Entry point ─────────────────────────────────────────────────────────────
//
// Usage:  kprobe-loader [iface] [ebpf-path]
//
//   iface      — network interface to attach to (default: eth0)
//   ebpf-path  — path to the compiled eBPF object file
//                (default: ../kprobe-ebpf/target/bpfel-unknown-none/debug/kprobe-ebpf)
//
// The program loads the eBPF object into the kernel, attaches it to the TC
// egress hook on the given interface, then polls the perf event array and
// prints every intercepted packet to stdout as:
//   [INTERCEPT] src=<ip>:<port> dst=<ip>:<port> proto=TCP|UDP

#[tokio::main]
async fn main() -> Result<()> {
    // RUST_LOG=info (or debug/warn) controls log verbosity.
    env_logger::init();

    let iface = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "eth0".to_string());

    let ebpf_path = std::env::args().nth(2).unwrap_or_else(|| {
        // Relative path from the kprobe-userspace working directory when
        // running via `cargo run` from the workspace root.
        "../kprobe-ebpf/target/bpfel-unknown-none/debug/kprobe-ebpf".to_string()
    });

    info!("[kprobe] Loading eBPF object from: {}", ebpf_path);
    info!("[kprobe] Attaching to interface:   {}", iface);

    // ── 1. Load the compiled eBPF object ─────────────────────────────────────
    let mut ebpf = Ebpf::load_file(&ebpf_path)
        .with_context(|| format!("Failed to load eBPF object '{}'", ebpf_path))?;

    // Wire up the eBPF logger so log::* calls inside the eBPF program appear
    // in this process's log output. Failure here is non-fatal.
    if let Err(e) = EbpfLogger::init(&mut ebpf) {
        warn!("[kprobe] eBPF logger unavailable (non-fatal): {}", e);
    }

    // ── 2. Add the clsact qdisc to the interface ──────────────────────────────
    //
    // TC programs require a clsact qdisc on the interface before they can be
    // attached. This call is idempotent — it succeeds if the qdisc already
    // exists (e.g. from a previous run that didn't clean up).
    if let Err(e) = tc::qdisc_add_clsact(&iface) {
        // EEXIST (error code 17) means the qdisc is already present — fine.
        let msg = format!("{}", e);
        if !msg.contains("17") {
            return Err(e).context("Failed to add clsact qdisc to interface")?;
        }
        info!("[kprobe] clsact qdisc already present on {} — continuing", iface);
    }

    // ── 3. Load and attach the TC classifier ─────────────────────────────────
    let program: &mut SchedClassifier = ebpf
        .program_mut("kprobe_egress")
        .context("Program 'kprobe_egress' not found in eBPF object")?
        .try_into()
        .context("'kprobe_egress' is not a SchedClassifier program")?;

    program
        .load()
        .context("Kernel rejected the eBPF program (verifier error)")?;

    program
        .attach(&iface, TcAttachType::Egress)
        .context("Failed to attach TC classifier to egress hook")?;

    info!(
        "[kprobe] eBPF program loaded on {} — intercepting pod-to-pod traffic",
        iface
    );

    // ── 4. Open the perf event array ─────────────────────────────────────────
    let mut perf_array = AsyncPerfEventArray::try_from(
        ebpf.take_map("PACKET_EVENTS")
            .context("Map 'PACKET_EVENTS' not found in eBPF object")?,
    )
    .context("Failed to open AsyncPerfEventArray")?;

    // ── 5. Spawn one reader task per online CPU ───────────────────────────────
    //
    // The kernel writes perf records to a per-CPU ring buffer. We must open
    // one reader per CPU and drain them independently, otherwise records will
    // be silently dropped when the buffer fills.
    let cpus = online_cpus()
        .map_err(|e| anyhow::anyhow!("Failed to enumerate online CPUs: {:?}", e))?;

    for cpu_id in cpus {
        let mut buf = perf_array
            .open(cpu_id, None)
            .with_context(|| format!("Failed to open perf buffer for CPU {}", cpu_id))?;

        tokio::spawn(async move {
            // Pre-allocate 10 receive slots. Each slot is large enough to
            // hold one PacketLog (8 bytes).
            let mut buffers: Vec<BytesMut> = (0..10)
                .map(|_| BytesMut::with_capacity(256))
                .collect();

            loop {
                let events = match buf.read_events(&mut buffers).await {
                    Ok(e) => e,
                    Err(e) => {
                        warn!(
                            "[kprobe] CPU {} perf buffer read error: {} — stopping reader",
                            cpu_id, e
                        );
                        break;
                    }
                };

                for slot in buffers.iter().take(events.read) {
                    if slot.len() < std::mem::size_of::<PacketLog>() {
                        // Undersized record — should never happen in practice.
                        warn!("[kprobe] Received undersized perf record, skipping");
                        continue;
                    }

                    // SAFETY: We wrote this exact PacketLog layout from the eBPF
                    // program and verified the buffer is large enough above.
                    let log: PacketLog = unsafe {
                        (slot.as_ptr() as *const PacketLog).read_unaligned()
                    };

                    let src = Ipv4Addr::from(u32::from_be(log.src_ip));
                    let dst = Ipv4Addr::from(u32::from_be(log.dst_ip));

                    let proto = match log.proto {
                        6  => "TCP",
                        17 => "UDP",
                        p  => {
                            warn!("[kprobe] Unknown protocol byte {}, skipping", p);
                            continue;
                        }
                    };

                    // This matches the expected output format from Test 1.A:
                    // [INTERCEPT] src=10.244.1.5:43210 dst=10.244.2.7:8080 proto=TCP
                    println!(
                        "[INTERCEPT] src={}:{} dst={}:{} proto={}",
                        src, log.src_port, dst, log.dst_port, proto
                    );
                }
            }
        });
    }

    info!("[kprobe] Listening — press Ctrl+C to stop and unload eBPF program");

    // ── 6. Block until Ctrl+C ─────────────────────────────────────────────────
    signal::ctrl_c().await?;

    info!("[kprobe] Shutting down — eBPF program unloaded");

    // `ebpf` drop here automatically detaches and unloads the eBPF program
    // from the kernel, satisfying the Phase 1 exit criterion:
    // "Unloading the eBPF program leaves cluster network fully functional."
    Ok(())
}
