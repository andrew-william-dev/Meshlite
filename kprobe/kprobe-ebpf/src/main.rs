#![no_std]
#![no_main]

use aya_ebpf::{
    macros::{classifier, map},
    maps::PerfEventArray,
    programs::TcContext,
};

// TC action: pass the packet through unchanged.
const TC_ACT_OK: i32 = 0;

// ─── Shared type ─────────────────────────────────────────────────────────────
//
// PacketLog is the record written into the perf event ring buffer for every
// intercepted IPv4 TCP/UDP packet. The userspace loader reads these records
// and prints them to stdout.
//
// MUST be #[repr(C)] so the in-memory layout is identical on both sides of
// the kernel/userspace boundary. The userspace crate redeclares this struct
// with the same layout.
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
    pub _pad:     u8,  // explicit padding — keeps the struct layout stable
}

// ─── BPF map ─────────────────────────────────────────────────────────────────
//
// Perf event array: kernel side writes PacketLog records; userspace reads them
// via an async poll loop. 1024 entries is more than sufficient for Phase 1 PoC.

#[map]
static PACKET_EVENTS: PerfEventArray<PacketLog> = PerfEventArray::new(0);

// ─── TC classifier ───────────────────────────────────────────────────────────
//
// Attached to the egress (outgoing) TC hook on the pod network interface.
// Fires on every outgoing packet before it leaves the kernel.

#[classifier]
pub fn kprobe_egress(ctx: TcContext) -> i32 {
    // Safety first: if anything goes wrong during parsing, pass the packet
    // through unchanged. We never drop a packet in Phase 1.
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

    // 3. Read source and destination IP addresses.
    let src_ip: u32 = ctx.load(26).map_err(|_| ())?;
    let dst_ip: u32 = ctx.load(30).map_err(|_| ())?;

    // 4. Read source and destination ports from the transport header.
    //    Fixed offset 34 assumes a standard 20-byte IP header (IHL=5).
    //    Kubernetes pod traffic never uses IP options, so this is safe.
    let src_port_be: u16 = ctx.load(34).map_err(|_| ())?;
    let dst_port_be: u16 = ctx.load(36).map_err(|_| ())?;

    // 5. Build the log record and write it to the perf event ring buffer.
    let log = PacketLog {
        src_ip,
        dst_ip,
        src_port: u16::from_be(src_port_be),
        dst_port: u16::from_be(dst_port_be),
        proto,
        _pad: 0,
    };

    PACKET_EVENTS.output(ctx, &log, 0);

    // 6. Always pass the packet through — Phase 1 never drops anything.
    Ok(TC_ACT_OK)
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
