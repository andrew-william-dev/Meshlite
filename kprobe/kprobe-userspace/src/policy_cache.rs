// policy_cache.rs — holds the current PolicyBundle pushed from Sigil.
//
// The cache is updated on every PolicyBundle push from the SigilClient stream.
// VerdictSync reads it to know which (from_svc, to_svc) pairs are allowed.

/// A single allow rule: traffic from `from_service` to any of `to_services`
/// is permitted.
#[derive(Clone, Debug)]
pub struct AllowRule {
    pub from_service: String,
    pub to_services:  Vec<String>,
}

pub struct PolicyCache {
    rules:         Vec<AllowRule>,
    default_allow: bool,
    /// "enforce" | "permissive" | "off"
    pub mtls_mode: String,
}

impl Clone for PolicyCache {
    fn clone(&self) -> Self {
        Self {
            rules:         self.rules.clone(),
            default_allow: self.default_allow,
            mtls_mode:     self.mtls_mode.clone(),
        }
    }
}

impl PolicyCache {
    pub fn new() -> Self {
        // Safe default while waiting for first PolicyBundle: allow everything so
        // the node is not black-holed before Sigil pushes the real policy.
        Self {
            rules:         Vec::new(),
            default_allow: true,
            mtls_mode:     "off".to_string(),
        }
    }

    /// Replace the current policy with data from a new PolicyBundle push.
    pub fn update(&mut self, rules: Vec<AllowRule>, default_allow: bool, mtls_mode: String) {
        self.rules = rules;
        self.default_allow = default_allow;
        self.mtls_mode = mtls_mode;
    }

    /// Returns true if traffic from `from_svc` to `to_svc` is permitted by the
    /// current policy. Checks explicit allow rules first, then falls back to
    /// `default_allow`.
    pub fn is_allowed(&self, from_svc: &str, to_svc: &str) -> bool {
        for rule in &self.rules {
            if rule.from_service == from_svc {
                if rule.to_services.iter().any(|t| t == to_svc) {
                    return true;
                }
                // Rule matches `from` but `to` is not listed — explicit deny.
                return false;
            }
        }
        // No rule matched — fall back to default.
        self.default_allow
    }

    pub fn default_allow(&self) -> bool {
        self.default_allow
    }

    pub fn rules(&self) -> &[AllowRule] {
        &self.rules
    }
}

impl Default for PolicyCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cache_one_way() -> PolicyCache {
        let mut c = PolicyCache::new();
        c.update(
            vec![AllowRule {
                from_service: "alpha".to_string(),
                to_services:  vec!["beta".to_string()],
            }],
            false,
            "enforce".to_string(),
        );
        c
    }

    #[test]
    fn allow_rule_matches() {
        let c = make_cache_one_way();
        assert!(c.is_allowed("alpha", "beta"));
    }

    #[test]
    fn deny_reverse_direction() {
        let c = make_cache_one_way();
        assert!(!c.is_allowed("beta", "alpha"));
    }

    #[test]
    fn deny_by_default_unmatched() {
        let c = make_cache_one_way();
        // "gamma" is not in the rules at all — default_allow is false.
        assert!(!c.is_allowed("gamma", "beta"));
    }

    #[test]
    fn allow_by_default_with_flag() {
        let mut c = PolicyCache::new();
        c.update(vec![], true, "off".to_string());
        assert!(c.is_allowed("any", "thing"));
    }

    #[test]
    fn initial_state_is_allow_all() {
        // Before any push arrives, the cache must not black-hole traffic.
        let c = PolicyCache::new();
        assert!(c.is_allowed("a", "b"));
    }

    #[test]
    fn update_replaces_rules() {
        let mut c = make_cache_one_way();
        // Add bidirectional rule.
        c.update(
            vec![
                AllowRule { from_service: "alpha".to_string(), to_services: vec!["beta".to_string()] },
                AllowRule { from_service: "beta".to_string(),  to_services: vec!["alpha".to_string()] },
            ],
            false,
            "enforce".to_string(),
        );
        assert!(c.is_allowed("alpha", "beta"));
        assert!(c.is_allowed("beta", "alpha"));
    }
}
