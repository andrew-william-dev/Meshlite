// cert_store.rs — in-memory certificate store for all services on this node.
//
// On first connect to Sigil, once a CertBundle is received, the store records
// the leaf cert PEM and private key PEM (both issued by Sigil) alongside the
// root CA PEM. This triple is used to build the TLS client config for the
// mTLS reconnect.
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
    /// Private key PEM — issued by Sigil alongside the leaf cert (PKCS#8).
    pub private_key_pem: Vec<u8>,
}

pub struct CertStore {
    certs: HashMap<String, StoredCert>,
}

impl CertStore {
    /// Create a new empty store.
    pub fn new() -> Self {
        Self {
            certs: HashMap::new(),
        }
    }

    /// Store or update the cert bundle for a service.
    /// All three PEM values must come from the Sigil CertBundle push.
    pub fn update(&mut self, service_id: &str, leaf_cert_pem: Vec<u8>, root_ca_pem: Vec<u8>, key_pem: Vec<u8>) {
        self.certs.insert(
            service_id.to_string(),
            StoredCert {
                leaf_cert_pem,
                root_ca_pem,
                private_key_pem: key_pem,
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
}

impl Default for CertStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_store_has_no_any() {
        let store = CertStore::new();
        assert!(!store.has_any());
        assert!(store.root_ca_pem().is_none());
        assert!(store.leaf_cert_pem("svc-a").is_none());
    }

    #[test]
    fn update_and_read_back() {
        let mut store = CertStore::new();
        store.update("svc-a", b"leaf-pem".to_vec(), b"root-pem".to_vec(), b"key-pem".to_vec());

        assert!(store.has_any());
        assert_eq!(store.root_ca_pem().unwrap(), b"root-pem");
        assert_eq!(store.leaf_cert_pem("svc-a").unwrap(), b"leaf-pem");
        assert!(store.leaf_cert_pem("svc-b").is_none());
    }

    #[test]
    fn first_cert_contains_sigil_key() {
        let mut store = CertStore::new();
        store.update("svc-a", b"leaf".to_vec(), b"root".to_vec(), b"sigil-issued-key".to_vec());
        let cert = store.first_cert().unwrap();
        assert_eq!(cert.private_key_pem, b"sigil-issued-key");
    }

    #[test]
    fn update_overwrites_existing() {
        let mut store = CertStore::new();
        store.update("svc-a", b"leaf-v1".to_vec(), b"root".to_vec(), b"key-v1".to_vec());
        store.update("svc-a", b"leaf-v2".to_vec(), b"root".to_vec(), b"key-v2".to_vec());
        assert_eq!(store.leaf_cert_pem("svc-a").unwrap(), b"leaf-v2");
    }
}
