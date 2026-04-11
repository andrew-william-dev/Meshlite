// policy_cache.rs — holds the current PolicyBundle pushed from Sigil.
//
// The cache is updated on every PolicyBundle push from the SigilClient stream
// (Kprobe) or from the Sigil REST API poll (Conduit).
// VerdictSync (Kprobe) and the proxy loop (Conduit) read it to decide allow/deny.

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

    /// Returns true if the given service appears as a destination in any allow rule.
    /// Used by Conduit Egress for destination-based policy checking when the source
    /// identity is not available (Phase 4 limitation — noted in AD-1 of phase4-approach.md).
    pub fn is_allowed_destination(&self, to_svc: &str) -> bool {
        for rule in &self.rules {
            if rule.to_services.iter().any(|t| t == to_svc) {
                return true;
            }
        }
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
    fn reverse_direction_denied() {
        let c = make_cache_one_way();
        assert!(!c.is_allowed("beta", "alpha"));
    }

    #[test]
    fn default_deny_blocks_unknown() {
        let c = make_cache_one_way();
        assert!(!c.is_allowed("gamma", "alpha"));
    }

    #[test]
    fn destination_check_allows_beta() {
        let c = make_cache_one_way();
        assert!(c.is_allowed_destination("beta"));
    }

    #[test]
    fn destination_check_denies_alpha() {
        let c = make_cache_one_way();
        // alpha is not in any to_services list
        assert!(!c.is_allowed_destination("alpha"));
    }

    #[test]
    fn default_allow_permits_everyone() {
        let mut c = PolicyCache::new();
        c.update(vec![], true, "off".to_string());
        assert!(c.is_allowed("anyone", "anything"));
        assert!(c.is_allowed_destination("anything"));
    }
}
