// cert_store.rs — in-memory certificate store for all services on this node.
//
// On first connect to Sigil, kprobe generates a local ECDSA P-256 key. When a
// CertBundle arrives (pushed by Sigil's OnConnect handler), the store records
// the leaf cert PEM (from Sigil) alongside the locally-generated private key.
// This pair is used to build the TLS client config for the mTLS reconnect.
//
// All services share the same Sigil root CA, so any stored bundle's
// `root_ca_pem` can be used as the trust anchor.

use std::collections::HashMap;

/// One certificate entry per service.
#[derive(Clone)]
pub struct StoredCert {
    /// Leaf cert PEM — issued by Sigil, contains the SPIFFE SAN.
    pub leaf_cert_pem: Vec<u8>,
    /// Root CA PEM — identical for all services; comes from Sigil.
    pub root_ca_pem: Vec<u8>,
    /// Private key PEM — generated locally by kprobe at startup.
    pub private_key_pem: Vec<u8>,
}

pub struct CertStore {
    certs: HashMap<String, StoredCert>,
    /// Shared private key PEM — generated once on startup for this agent.
    local_key_pem: Vec<u8>,
}

impl CertStore {
    /// Create a new store with the given locally-generated private key PEM.
    pub fn new(local_key_pem: Vec<u8>) -> Self {
        Self {
            certs: HashMap::new(),
            local_key_pem,
        }
    }

    /// Store or update the cert bundle for a service.
    /// The private key is taken from the local key generated at startup.
    pub fn update(&mut self, service_id: &str, leaf_cert_pem: Vec<u8>, root_ca_pem: Vec<u8>) {
        self.certs.insert(
            service_id.to_string(),
            StoredCert {
                leaf_cert_pem,
                root_ca_pem,
                private_key_pem: self.local_key_pem.clone(),
            },
        );
    }

    /// Returns true if at least one cert bundle has been received from Sigil.
    pub fn has_any(&self) -> bool {
        !self.certs.is_empty()
    }

    /// Returns the root CA PEM from any stored cert (all share the same root).
    pub fn root_ca_pem(&self) -> Option<&[u8]> {
        self.certs.values().next().map(|c| c.root_ca_pem.as_slice())
    }

    /// Returns the leaf cert PEM for a given service.
    pub fn leaf_cert_pem(&self, service_id: &str) -> Option<&[u8]> {
        self.certs.get(service_id).map(|c| c.leaf_cert_pem.as_slice())
    }

    /// Returns the first stored cert entry (for building the TLS client config).
    /// In Phase 3 all services on a node share one identity; any leaf cert works.
    pub fn first_cert(&self) -> Option<&StoredCert> {
        self.certs.values().next()
    }

    /// Returns the local private key PEM.
    pub fn local_key_pem(&self) -> &[u8] {
        &self.local_key_pem
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_store() -> CertStore {
        CertStore::new(b"fake-key-pem".to_vec())
    }

    #[test]
    fn empty_store_has_no_any() {
        let store = make_store();
        assert!(!store.has_any());
        assert!(store.root_ca_pem().is_none());
        assert!(store.leaf_cert_pem("svc-a").is_none());
    }

    #[test]
    fn update_and_read_back() {
        let mut store = make_store();
        store.update("svc-a", b"leaf-pem".to_vec(), b"root-pem".to_vec());

        assert!(store.has_any());
        assert_eq!(store.root_ca_pem().unwrap(), b"root-pem");
        assert_eq!(store.leaf_cert_pem("svc-a").unwrap(), b"leaf-pem");
        assert!(store.leaf_cert_pem("svc-b").is_none());
    }

    #[test]
    fn first_cert_contains_local_key() {
        let mut store = make_store();
        store.update("svc-a", b"leaf".to_vec(), b"root".to_vec());
        let cert = store.first_cert().unwrap();
        assert_eq!(cert.private_key_pem, b"fake-key-pem");
    }

    #[test]
    fn update_overwrites_existing() {
        let mut store = make_store();
        store.update("svc-a", b"leaf-v1".to_vec(), b"root".to_vec());
        store.update("svc-a", b"leaf-v2".to_vec(), b"root".to_vec());
        assert_eq!(store.leaf_cert_pem("svc-a").unwrap(), b"leaf-v2");
    }
}
