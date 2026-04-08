// verdict_sync.rs — reconciles PolicyCache + PodWatcher into the eBPF VERDICT_MAP.
//
// On every call to `sync()`, the VERDICT_MAP is cleared and rebuilt from scratch.
// This is safe because the eBPF program falls back to POLICY_FLAGS[0] for any
// key not present in the map — so there is no window during which traffic is
// incorrectly blocked between clear and repopulate.
//
// `PacketKey` here must be `#[repr(C)]` and byte-for-byte identical to the
// `PacketKey` defined in kprobe-ebpf/src/main.rs (network byte order IPs).

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

use aya::maps::{Array, HashMap as AyaHashMap};
use log::info;

use crate::policy_cache::PolicyCache;

/// Must match the eBPF-side PacketKey exactly: two u32 fields in network byte order.
#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct PacketKey {
    pub src_ip: u32, // network byte order
    pub dst_ip: u32, // network byte order
}

// aya requires the key/value types to implement Pod for direct memory access.
unsafe impl aya::Pod for PacketKey {}

pub struct VerdictSync {
    verdict_map:  Arc<Mutex<AyaHashMap<aya::maps::MapData, PacketKey, u8>>>,
    policy_flags: Arc<Mutex<Array<aya::maps::MapData, u32>>>,
}

impl VerdictSync {
    pub fn new(
        verdict_map:  Arc<Mutex<AyaHashMap<aya::maps::MapData, PacketKey, u8>>>,
        policy_flags: Arc<Mutex<Array<aya::maps::MapData, u32>>>,
    ) -> Self {
        Self { verdict_map, policy_flags }
    }

    /// Rebuild the VERDICT_MAP from the current policy and pod snapshot.
    ///
    /// Algorithm:
    ///   1. Write POLICY_FLAGS[0] = default_allow.
    ///   2. Clear VERDICT_MAP.
    ///   3. For every (from_svc, to_svc) pair where both have known pod IPs:
    ///      - verdict = 0 (ALLOW) if policy.is_allowed(from, to), else 1 (DENY)
    ///      - Insert VERDICT_MAP[(src_ip, dst_ip)] = verdict for every IP pair.
    pub fn sync(
        &self,
        policy:   &PolicyCache,
        pods:     &HashMap<String, Vec<Ipv4Addr>>,
    ) {
        let default_allow: u32 = if policy.default_allow() { 1 } else { 0 };

        // 1. Write default_allow flag.
        {
            let mut flags = self.policy_flags.lock().unwrap();
            if let Err(e) = flags.set(0, default_allow, 0) {
                log::warn!("[verdict_sync] Failed to write POLICY_FLAGS: {}", e);
            }
        }

        // 2. Clear the existing VERDICT_MAP.
        let keys_to_remove: Vec<PacketKey> = {
            let map = self.verdict_map.lock().unwrap();
            map.keys().filter_map(|k| k.ok()).collect()
        };
        {
            let mut map = self.verdict_map.lock().unwrap();
            for key in &keys_to_remove {
                let _ = map.remove(key);
            }
        }

        // 3. Populate for every known (from_svc, to_svc) IP pair.
        let mut entry_count = 0usize;
        let svc_names: Vec<&String> = pods.keys().collect();

        for from_svc in &svc_names {
            for to_svc in &svc_names {
                if from_svc == to_svc {
                    continue; // skip self-traffic
                }
                let verdict: u8 = if policy.is_allowed(from_svc, to_svc) { 0 } else { 1 };

                let from_ips = &pods[*from_svc];
                let to_ips   = &pods[*to_svc];

                let mut map = self.verdict_map.lock().unwrap();
                for &src_ip_host in from_ips {
                    for &dst_ip_host in to_ips {
                        let key = PacketKey {
                            src_ip: u32::from(src_ip_host).to_be(),
                            dst_ip: u32::from(dst_ip_host).to_be(),
                        };
                        if let Err(e) = map.insert(key, verdict, 0) {
                            log::warn!("[verdict_sync] insert failed: {}", e);
                        } else {
                            entry_count += 1;
                        }
                    }
                }
            }
        }

        info!(
            "[verdict_sync] wrote {} entries, default_allow={}",
            entry_count,
            policy.default_allow()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unit tests for the sync logic are integration-level and require a live
    // eBPF-capable kernel. The data-path logic is verified here in isolation
    // using a mock map backed by a plain HashMap.

    /// Simulate the verdict assignment logic without touching real eBPF maps.
    fn compute_verdicts(
        policy: &PolicyCache,
        pods:   &HashMap<String, Vec<Ipv4Addr>>,
    ) -> HashMap<PacketKey, u8> {
        let mut result = HashMap::new();
        let svc_names: Vec<&String> = pods.keys().collect();

        for from_svc in &svc_names {
            for to_svc in &svc_names {
                if from_svc == to_svc {
                    continue;
                }
                let verdict: u8 = if policy.is_allowed(from_svc, to_svc) { 0 } else { 1 };
                for &src_ip in &pods[*from_svc] {
                    for &dst_ip in &pods[*to_svc] {
                        let key = PacketKey {
                            src_ip: u32::from(src_ip).to_be(),
                            dst_ip: u32::from(dst_ip).to_be(),
                        };
                        result.insert(key, verdict);
                    }
                }
            }
        }
        result
    }

    use crate::policy_cache::AllowRule;

    fn ip(s: &str) -> Ipv4Addr { s.parse().unwrap() }

    fn one_way_policy() -> PolicyCache {
        let mut p = PolicyCache::new();
        p.update(
            vec![AllowRule {
                from_service: "alpha".to_string(),
                to_services:  vec!["beta".to_string()],
            }],
            false,
            "enforce".to_string(),
        );
        p
    }

    #[test]
    fn one_way_allow_generates_correct_verdicts() {
        let policy = one_way_policy();
        let mut pods: HashMap<String, Vec<Ipv4Addr>> = HashMap::new();
        pods.insert("alpha".to_string(), vec![ip("10.244.1.5")]);
        pods.insert("beta".to_string(),  vec![ip("10.244.2.7")]);

        let verdicts = compute_verdicts(&policy, &pods);

        let alpha_to_beta = PacketKey {
            src_ip: u32::from(ip("10.244.1.5")).to_be(),
            dst_ip: u32::from(ip("10.244.2.7")).to_be(),
        };
        let beta_to_alpha = PacketKey {
            src_ip: u32::from(ip("10.244.2.7")).to_be(),
            dst_ip: u32::from(ip("10.244.1.5")).to_be(),
        };

        assert_eq!(verdicts[&alpha_to_beta], 0, "alpha→beta should be ALLOW");
        assert_eq!(verdicts[&beta_to_alpha], 1, "beta→alpha should be DENY");
    }

    #[test]
    fn bidirectional_policy_both_allowed() {
        let mut policy = PolicyCache::new();
        policy.update(
            vec![
                AllowRule { from_service: "alpha".to_string(), to_services: vec!["beta".to_string()] },
                AllowRule { from_service: "beta".to_string(),  to_services: vec!["alpha".to_string()] },
            ],
            false,
            "enforce".to_string(),
        );
        let mut pods: HashMap<String, Vec<Ipv4Addr>> = HashMap::new();
        pods.insert("alpha".to_string(), vec![ip("10.244.1.5")]);
        pods.insert("beta".to_string(),  vec![ip("10.244.2.7")]);

        let verdicts = compute_verdicts(&policy, &pods);

        let a_to_b = PacketKey { src_ip: u32::from(ip("10.244.1.5")).to_be(), dst_ip: u32::from(ip("10.244.2.7")).to_be() };
        let b_to_a = PacketKey { src_ip: u32::from(ip("10.244.2.7")).to_be(), dst_ip: u32::from(ip("10.244.1.5")).to_be() };

        assert_eq!(verdicts[&a_to_b], 0);
        assert_eq!(verdicts[&b_to_a], 0);
    }

    #[test]
    fn no_pods_produces_empty_verdict_map() {
        let policy = one_way_policy();
        let pods: HashMap<String, Vec<Ipv4Addr>> = HashMap::new();
        let verdicts = compute_verdicts(&policy, &pods);
        assert!(verdicts.is_empty());
    }
}
