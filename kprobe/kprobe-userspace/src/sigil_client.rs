// sigil_client.rs — gRPC streaming client for Sigil with mTLS reconnect.
//
// Three-state machine:
//
//   Bootstrap     → plaintext connection (no client cert yet)
//                   sends AgentHello; waits for first CertBundle
//                   on receipt: updates CertStore, transitions → UpgradingTLS
//
//   UpgradingTLS  → closes plaintext channel
//                   builds TLS channel (client cert = SPIFFE leaf from CertStore)
//                   re-sends AgentHello, transitions → ConnectedTLS
//
//   ConnectedTLS  → normal streaming; CertBundle/PolicyBundle pushed here
//                   on disconnect: transitions back → UpgradingTLS

use std::sync::{Arc, Mutex};
use std::time::Duration;

use log::{info, warn};
use rustls::pki_types::CertificateDer;
use rustls_pemfile::{certs, pkcs8_private_keys};
use tokio::sync::mpsc;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};

use crate::cert_store::CertStore;
use crate::policy_cache::{AllowRule, PolicyCache};
use crate::pod_watcher::PodSnapshot;

// Import the generated proto types (module path set by tonic-build / prost).
pub mod proto {
    tonic::include_proto!("sigil.v1");
}
use proto::{
    sigil_agent_client::SigilAgentClient,
    agent_push::Payload,
    AgentHello,
};

// Re-connect back-off: wait this long between reconnect attempts.
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
enum State {
    Bootstrap,
    UpgradingTLS,
    ConnectedTLS,
}

pub struct SigilClient {
    sigil_addr:   String,
    node_id:      String,
    cluster_id:   String,
    pod_snapshot: Arc<Mutex<PodSnapshot>>,
}

impl SigilClient {
    pub fn new(
        sigil_addr:   String,
        node_id:      String,
        cluster_id:   String,
        pod_snapshot: Arc<Mutex<PodSnapshot>>,
    ) -> Self {
        Self { sigil_addr, node_id, cluster_id, pod_snapshot }
    }

    /// Async run loop.  Sends on `sync_tx` whenever a CertBundle or PolicyBundle
    /// is received so that VerdictSync can reconcile the eBPF maps.
    pub async fn run(
        self,
        cert_store:   Arc<Mutex<CertStore>>,
        policy_cache: Arc<Mutex<PolicyCache>>,
        sync_tx:      mpsc::Sender<()>,
    ) {
        let mut state = State::Bootstrap;

        loop {
            match state {
                State::Bootstrap => {
                    info!("[sigil_client] state=Bootstrap addr={}", self.sigil_addr);
                    match self.bootstrap_connect().await {
                        Ok(mut client) => {
                            let hello = self.make_hello();
                            match client.subscribe(hello).await {
                                Ok(response) => {
                                    let mut stream = response.into_inner();
                                    // Drain until we get the first CertBundle.
                                    loop {
                                        match stream.message().await {
                                            Ok(Some(push)) => {
                                                match push.payload {
                                                    Some(Payload::Cert(bundle)) => {
                                                        info!(
                                                            "[sigil_client] CertBundle received service={}",
                                                            bundle.service_id
                                                        );
                                                        cert_store.lock().unwrap().update(
                                                            &bundle.service_id,
                                                            bundle.service_cert_pem,
                                                            bundle.root_ca_pem,
                                                            bundle.key_pem,
                                                        );
                                                        let _ = sync_tx.send(()).await;
                                                        state = State::UpgradingTLS;
                                                        break;
                                                    }
                                                    Some(Payload::Policy(pb)) => {
                                                        apply_policy_bundle(pb, &policy_cache);
                                                        let _ = sync_tx.send(()).await;
                                                    }
                                                    None => {}
                                                }
                                            }
                                            Ok(None) => {
                                                warn!("[sigil_client] Bootstrap stream closed");
                                                break;
                                            }
                                            Err(e) => {
                                                warn!("[sigil_client] Bootstrap stream error: {:?}", e);
                                                break;
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    warn!("[sigil_client] Bootstrap Subscribe RPC failed: {}", e);
                                }
                            }
                        }
                        Err(e) => {
                            warn!("[sigil_client] Bootstrap channel failed: {}", e);
                        }
                    }
                    if state == State::Bootstrap {
                        tokio::time::sleep(RECONNECT_DELAY).await;
                    }
                }

                State::UpgradingTLS => {
                    info!("[sigil_client] state=UpgradingTLS node={}", self.node_id);
                    let tls_result = {
                        let store = cert_store.lock().unwrap();
                        build_tls_channel(&self.sigil_addr, &store)
                    };
                    match tls_result {
                        Ok(mut client) => {
                            let hello = self.make_hello();
                            match client.subscribe(hello).await {
                                Ok(_) => {
                                    info!("[sigil_client] mTLS reconnect node={} cluster={}",
                                        self.node_id, self.cluster_id);
                                    state = State::ConnectedTLS;
                                    // Fall through to ConnectedTLS directly next iteration.
                                }
                                Err(e) => {
                                    warn!("[sigil_client] mTLS Subscribe RPC failed: {} — retrying", e);
                                    tokio::time::sleep(RECONNECT_DELAY).await;
                                }
                            }
                        }
                        Err(e) => {
                            warn!("[sigil_client] TLS channel build failed: {} — falling back to Bootstrap", e);
                            state = State::Bootstrap;
                            tokio::time::sleep(RECONNECT_DELAY).await;
                        }
                    }
                }

                State::ConnectedTLS => {
                    info!("[sigil_client] state=ConnectedTLS node={}", self.node_id);
                    let tls_result = {
                        let store = cert_store.lock().unwrap();
                        build_tls_channel(&self.sigil_addr, &store)
                    };
                    match tls_result {
                        Ok(mut client) => {
                            let hello = self.make_hello();
                            match client.subscribe(hello).await {
                                Ok(response) => {
                                    info!("[sigil_client] connected node={} cluster={}",
                                        self.node_id, self.cluster_id);
                                    let mut stream = response.into_inner();
                                    loop {
                                        match stream.message().await {
                                            Ok(Some(push)) => {
                                                match push.payload {
                                                    Some(Payload::Cert(bundle)) => {
                                                        info!("[sigil_client] CertBundle received service={}",
                                                            bundle.service_id);
                                                        cert_store.lock().unwrap().update(
                                                            &bundle.service_id,
                                                            bundle.service_cert_pem,
                                                            bundle.root_ca_pem,
                                                            bundle.key_pem,
                                                        );
                                                        let _ = sync_tx.send(()).await;
                                                    }
                                                    Some(Payload::Policy(pb)) => {
                                                        let rule_count = pb.rules.len();
                                                        apply_policy_bundle(pb, &policy_cache);
                                                        info!("[sigil_client] [POLICY] updated rules={}",
                                                            rule_count);
                                                        let _ = sync_tx.send(()).await;
                                                    }
                                                    None => {}
                                                }
                                            }
                                            Ok(None) => {
                                                warn!("[sigil_client] ConnectedTLS stream closed");
                                                break;
                                            }
                                            Err(e) => {
                                                warn!("[sigil_client] ConnectedTLS stream error: {}", e);
                                                break;
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    warn!("[sigil_client] ConnectedTLS Subscribe RPC failed: {}", e);
                                }
                            }
                        }
                        Err(e) => {
                            warn!("[sigil_client] TLS channel rebuild failed: {}", e);
                        }
                    }
                    state = State::UpgradingTLS;
                    tokio::time::sleep(RECONNECT_DELAY).await;
                }
            }
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    fn make_hello(&self) -> AgentHello {
        let mut svc_ids = self.pod_snapshot.lock().unwrap()
            .keys()
            .cloned()
            .collect::<Vec<String>>();
        // Always include the node agent itself so Sigil issues at least one cert.
        if !svc_ids.contains(&self.node_id) {
            svc_ids.insert(0, self.node_id.clone());
        }
        AgentHello {
            node_id:         self.node_id.clone(),
            cluster_id:      self.cluster_id.clone(),
            pod_service_ids: svc_ids,
        }
    }

    async fn bootstrap_connect(
        &self,
    ) -> Result<SigilAgentClient<Channel>, tonic::transport::Error> {
        // Bootstrap uses the plaintext gRPC port (8444) on Sigil — no client
        // cert available yet.  The TLS channel (8443) is used after UpgradingTLS.
        let plain_addr = self.sigil_addr
            .replace(":8443", ":8444");
        info!("[sigil_client] Bootstrap connecting to plaintext addr={}", plain_addr);
        let endpoint = Endpoint::from_shared(format!("http://{}", plain_addr))?
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30));
        let channel = endpoint.connect().await?;
        Ok(SigilAgentClient::new(channel))
    }
}

/// Build a tonic TLS channel using the cert from CertStore.
/// Returns an error if CertStore has no cert yet (shouldn't happen after Bootstrap).
fn build_tls_channel(
    addr:  &str,
    store: &CertStore,
) -> Result<SigilAgentClient<Channel>, Box<dyn std::error::Error + Send + Sync>> {
    let cert = store.first_cert().ok_or("CertStore is empty")?;

    // Parse root CA for server verification.
    let root_ca_pem = cert.root_ca_pem.clone();
    let mut root_ca_reader = std::io::Cursor::new(&root_ca_pem);
    let root_certs: Vec<CertificateDer<'static>> = certs(&mut root_ca_reader)
        .filter_map(|c| c.ok())
        .collect();
    if root_certs.is_empty() {
        return Err("CertStore root CA PEM contains no certificates".into());
    }

    // Parse client leaf cert.
    let leaf_pem = cert.leaf_cert_pem.clone();
    let mut leaf_reader = std::io::Cursor::new(&leaf_pem);
    let _leaf_certs: Vec<CertificateDer<'static>> = certs(&mut leaf_reader)
        .filter_map(|c| c.ok())
        .collect();

    // Parse private key.
    let key_pem = cert.private_key_pem.clone();
    let mut key_reader = std::io::Cursor::new(&key_pem);
    let keys: Vec<_> = pkcs8_private_keys(&mut key_reader)
        .filter_map(|k| k.ok())
        .collect();
    let private_key = keys.into_iter().next().ok_or("No PKCS#8 private key found in PEM")?;

    // Build tonic TLS config.
    let identity = tonic::transport::Identity::from_pem(leaf_pem, key_pem);

    let mut root_cert_store = rustls::RootCertStore::empty();
    for cert_der in root_certs {
        root_cert_store.add(cert_der)?;
    }
    let _ = private_key; // consumed via tonic Identity above

    let tls_config = ClientTlsConfig::new()
        .identity(identity)
        .ca_certificate(tonic::transport::Certificate::from_pem(
            cert.root_ca_pem.clone(),
        ))
        .domain_name("sigil");

    let endpoint = Endpoint::from_shared(format!("https://{}", addr))?
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .tls_config(tls_config)?;

    // Connect lazily — the actual TCP handshake happens on first RPC call.
    let channel = endpoint.connect_lazy();
    Ok(SigilAgentClient::new(channel))
}

/// Apply a PolicyBundle push to the PolicyCache.
fn apply_policy_bundle(pb: proto::PolicyBundle, cache: &Arc<Mutex<PolicyCache>>) {
    let rules: Vec<AllowRule> = pb
        .rules
        .into_iter()
        .map(|r| AllowRule {
            from_service: r.from_service,
            to_services:  r.to_services,
        })
        .collect();
    cache.lock().unwrap().update(rules, pb.default_allow, pb.mtls_mode);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cert_store::CertStore;

    #[test]
    fn apply_policy_bundle_updates_cache() {
        let cache = Arc::new(Mutex::new(PolicyCache::new()));
        let pb = proto::PolicyBundle {
            rules: vec![proto::AllowRule {
                from_service: "alpha".to_string(),
                to_services:  vec!["beta".to_string()],
            }],
            default_allow: false,
            mtls_mode:     "enforce".to_string(),
        };
        apply_policy_bundle(pb, &cache);
        let c = cache.lock().unwrap();
        assert!(c.is_allowed("alpha", "beta"));
        assert!(!c.is_allowed("beta", "alpha"));
    }

    #[test]
    fn client_constructs_hello() {
        use crate::pod_watcher::PodSnapshot;
        let mut snapshot = PodSnapshot::new();
        snapshot.insert("service-alpha".to_string(), vec![]);
        let pod_snapshot = Arc::new(Mutex::new(snapshot));
        let client = SigilClient::new(
            "sigil:8443".to_string(),
            "node-1".to_string(),
            "dev".to_string(),
            pod_snapshot,
        );
        let hello = client.make_hello();
        assert_eq!(hello.node_id, "node-1");
        assert_eq!(hello.cluster_id, "dev");
        assert!(hello.pod_service_ids.contains(&"node-1".to_string()));
        assert!(hello.pod_service_ids.contains(&"service-alpha".to_string()));
    }

    #[test]
    fn build_tls_channel_fails_on_empty_store() {
        let store = CertStore::new();
        let result = build_tls_channel("sigil:8443", &store);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
    }
}
