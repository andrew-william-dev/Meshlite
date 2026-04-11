// lib.rs — meshlite-tls shared crate.
// Provides CertStore and PolicyCache to both Kprobe and Conduit.
// No network or eBPF dependencies — pure safe Rust data structures.

pub mod cert_store;
pub mod policy_cache;
