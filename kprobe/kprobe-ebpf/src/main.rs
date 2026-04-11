#![no_std]
#![no_main]

use aya_ebpf::{
    macros::{classifier, map},
    maps::{Array, HashMap, PerfEventArray},
    programs::TcContext,
};

// TC actions.
const TC_ACT_OK:   i32 = 0; // pass packet through
const TC_ACT_SHOT: i32 = 2; // drop packet

// ─── Pod CIDR guard ───────────────────────────────────────────────────────────
//
// Only consult VERDICT_MAP for traffic whose source IP is in the pod CIDR.
// kind assigns pod IPs from 10.244.0.0/16. Node traffic (172.18.0.0/16) must
// always pass to avoid disrupting kubelet heartbeats.
//
// Stored in network byte order — 0x0AF40000 == 10.244.0.0 big-endian.
const POD_CIDR_NET:  u32 = 0x0AF40000_u32.to_be(); // 10.244.0.0
const POD_CIDR_MASK: u32 = 0xFFFF0000_u32.to_be(); // /16

// ─── Shared types ─────────────────────────────────────────────────────────────
//
// PacketLog and PacketKey are #[repr(C)] so their in-memory layout is identical
// on both sides of the kernel/userspace boundary. The userspace crate redeclares
// these structs with the same layout.
//
// Phase 1 assumes a standard 20-byte IPv4 header (no IP options). This is
// correct for pod-to-pod traffic inside Kubernetes — the CNI never generates
// IP-options headers in normal operation.

#[repr(C)]
#[derive(Copy, Clone)]
pub struct PacketLog {
    pub src_ip:   u32, // network byte order
    pub dst_ip:   u32, // network byte order
    pub src_port: u16, // host byte order
    pub dst_port: u16, // host byte order
    pub proto:    u8,  // 6 = TCP, 17 = UDP
    pub verdict:  u8,  // 0 = ALLOW, 1 = DENY (replaces _pad from Phase 1)
}

// PacketKey is the key type for VERDICT_MAP.
// Both fields are in network byte order, matching what ctx.load() returns.
#[repr(C)]
#[derive(Copy, Clone)]
pub struct PacketKey {
    pub src_ip: u32, // network byte order
    pub dst_ip: u32, // network byte order
}

// ─── BPF maps ─────────────────────────────────────────────────────────────────

// Perf event array: kernel side writes PacketLog records; userspace reads them.
#[map]
static PACKET_EVENTS: PerfEventArray<PacketLog> = PerfEventArray::new(0);

// Verdict map: userspace writes allow/deny decisions per (src_ip, dst_ip) pair.
// Value: 0 = ALLOW, 1 = DENY.
// Capacity 4096 supports up to 4096 distinct src→dst pod IP pairs.
#[map]
static VERDICT_MAP: HashMap<PacketKey, u8> = HashMap::with_max_entries(4096, 0);

// Policy flags: [0] = default_allow (0 = deny-unmatched, 1 = allow-unmatched).
// Userspace writes this once after every PolicyBundle push.
#[map]
static POLICY_FLAGS: Array<u32> = Array::with_max_entries(1, 0);

// ─── TC classifier ───────────────────────────────────────────────────────────
//
// Attached to the egress (outgoing) TC hook on the pod network interface.
// Fires on every outgoing packet before it leaves the kernel.

#[classifier]
pub fn kprobe_egress(ctx: TcContext) -> i32 {
    // Safety first: if anything goes wrong during parsing, pass the packet
    // through unchanged. We never drop a packet on parse error.
    match try_intercept(&ctx) {
        Ok(action) => action,
        Err(_)     => TC_ACT_OK,
    }
}

// ─── Packet parsing ──────────────────────────────────────────────────────────
//
// Byte offsets for a standard Ethernet + IPv4 + TCP/UDP frame:
//
//   [0  .. 5 ] — Ethernet dst MAC
//   [6  .. 11] — Ethernet src MAC
//   [12 .. 13] — EtherType  (0x0800 = IPv4)
//   [14]       — IPv4 version+IHL
//   [23]       — IPv4 protocol (6=TCP, 17=UDP)
//   [26 .. 29] — IPv4 source address
//   [30 .. 33] — IPv4 destination address
//   [34 .. 35] — TCP/UDP source port
//   [36 .. 37] — TCP/UDP destination port

#[inline(always)]
fn try_intercept(ctx: &TcContext) -> Result<i32, ()> {
    // 1. Only process IPv4 frames.
    let ethertype: u16 = ctx.load(12).map_err(|_| ())?;
    if ethertype != u16::to_be(0x0800) {
        return Ok(TC_ACT_OK);
    }

    // 2. Only process TCP (6) and UDP (17).
    let proto: u8 = ctx.load(23).map_err(|_| ())?;
    if proto != 6 && proto != 17 {
        return Ok(TC_ACT_OK);
    }

    // 3. Read source and destination IP addresses (network byte order).
    let src_ip: u32 = ctx.load(26).map_err(|_| ())?;
    let dst_ip: u32 = ctx.load(30).map_err(|_| ())?;

    // 4. Read source and destination ports from the transport header.
    //    Fixed offset 34 assumes a standard 20-byte IP header (IHL=5).
    //    Kubernetes pod traffic never uses IP options, so this is safe.
    let src_port_be: u16 = ctx.load(34).map_err(|_| ())?;
    let dst_port_be: u16 = ctx.load(36).map_err(|_| ())?;

    // 5. Verdict decision — only for pod-to-pod traffic (BOTH src AND dst in
    //    pod CIDR).  Traffic to/from node IPs (kubelet, kube-proxy DNAT
    //    SYN-ACKs, Sigil ClusterIP responses, etc.) always passes through.
    let verdict: u8 = if src_ip & POD_CIDR_MASK == POD_CIDR_NET
                      && dst_ip & POD_CIDR_MASK == POD_CIDR_NET {
        let key = PacketKey { src_ip, dst_ip };
        match unsafe { VERDICT_MAP.get(&key) } {
            Some(v) => *v,     // explicit allow (0) or deny (1)
            None => {
                // No explicit verdict — consult default_allow flag.
                match POLICY_FLAGS.get(0) {
                    Some(flag) if *flag == 0 => 1, // deny-unmatched
                    _                        => 0, // allow-unmatched (default while map is empty on startup)
                }
            }
        }
    } else {
        0 // non-pod traffic always allowed
    };

    // 5b. For TCP: only DENY new connection initiations (SYN without ACK).
    //     Established-flow packets (ACK set) are always allowed so that return
    //     traffic for permitted connections is not inadvertently blocked by the
    //     egress hook on the responding node.
    //     TCP flags are at offset 47 in a standard 14-byte Ethernet + 20-byte
    //     IPv4 (IHL=5, no options) + TCP frame.
    let verdict = if proto == 6 && verdict == 1 {
        match ctx.load::<u8>(47) {
            Ok(tcp_flags) => {
                // SYN=0x02, ACK=0x10 — new SYN has SYN set and ACK not set
                if (tcp_flags & 0x12) == 0x02 { 1 } else { 0 }
            }
            Err(_) => 0, // cannot read flags → be conservative, allow
        }
    } else {
        verdict
    };

    let action = if verdict == 1 { TC_ACT_SHOT } else { TC_ACT_OK };

    // 6. Write the log record to the perf event ring buffer.
    let log = PacketLog {
        src_ip,
        dst_ip,
        src_port: u16::from_be(src_port_be),
        dst_port: u16::from_be(dst_port_be),
        proto,
        verdict,
    };
    PACKET_EVENTS.output(ctx, &log, 0);

    Ok(action)
}

// ─── Panic handler ───────────────────────────────────────────────────────────
//
// Required for #![no_std] targets. The eBPF verifier rejects programs that can
// panic at runtime, so this is unreachable in practice — all errors return
// TC_ACT_OK via the Result path above.

#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
