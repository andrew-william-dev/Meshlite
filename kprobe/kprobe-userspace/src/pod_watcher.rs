// pod_watcher.rs — watches Kubernetes pods on the local node.
//
// Uses the `kube` crate's reflector/watcher pattern to maintain a live snapshot
// of pods scheduled on this node. The `app` label value is used as the service
// identity (matching the convention in tests/fixtures/test-services.yaml and
// the Sigil policy engine).
//
// On every pod add/update/delete, sends a `PodEvent` on the provided channel
// so that VerdictSync can re-reconcile the VERDICT_MAP.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

use k8s_openapi::api::core::v1::Pod;
use kube::{
    runtime::watcher::{self, Event},
    Api, Client,
};
use log::{info, warn};
use tokio::sync::mpsc;
use futures::StreamExt;

/// Events emitted by the pod watcher to VerdictSync.
#[derive(Debug)]
pub enum PodEvent {
    /// Triggered whenever the pod snapshot has changed (added, updated or deleted).
    Changed,
}

/// Shared snapshot: service_id (app label) → list of pod IPv4 addresses.
pub type PodSnapshot = HashMap<String, Vec<Ipv4Addr>>;

/// PodWatcher watches pods on `node_name` and maintains a live snapshot.
pub struct PodWatcher {
    node_name: String,
    snapshot:  Arc<Mutex<PodSnapshot>>,
}

impl PodWatcher {
    pub fn new(node_name: String) -> Self {
        Self {
            node_name,
            snapshot: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Returns a clone of the Arc so VerdictSync can read the snapshot.
    pub fn snapshot_handle(&self) -> Arc<Mutex<PodSnapshot>> {
        Arc::clone(&self.snapshot)
    }

    /// Returns the current snapshot (cloned).
    pub fn snapshot(&self) -> PodSnapshot {
        self.snapshot.lock().unwrap().clone()
    }

    /// Async task: watches pods on the local node and keeps the snapshot current.
    /// Sends a `PodEvent::Changed` on `tx` after every reconcile.
    pub async fn run(self, tx: mpsc::Sender<PodEvent>) {
        let client = match Client::try_default().await {
            Ok(c) => c,
            Err(e) => {
                warn!("[pod_watcher] Could not build kube client: {} — pod watching disabled", e);
                return;
            }
        };

        let pods: Api<Pod> = Api::all(client);
        let node = self.node_name.clone();
        let snapshot = Arc::clone(&self.snapshot);

        let config = watcher::Config::default()
            .fields(&format!("spec.nodeName={}", node));
        let mut stream = watcher::watcher(pods, config).boxed();

        info!("[pod_watcher] Watching pods on node={}", node);

        while let Some(event) = stream.next().await {
            match event {
                Ok(Event::Apply(pod)) | Ok(Event::InitApply(pod)) => {
                    if let Some((svc_id, ip)) = extract_service_and_ip(&pod) {
                        {
                            let mut snap = snapshot.lock().unwrap();
                            snap.entry(svc_id).or_default().push(ip);
                            // De-duplicate IPs.
                            snap.values_mut().for_each(|v| { v.sort(); v.dedup(); });
                        } // guard dropped here — before .await
                        let _ = tx.send(PodEvent::Changed).await;
                    }
                }
                Ok(Event::Delete(pod)) => {
                    if let Some((svc_id, ip)) = extract_service_and_ip(&pod) {
                        {
                            let mut snap = snapshot.lock().unwrap();
                            if let Some(ips) = snap.get_mut(&svc_id) {
                                ips.retain(|i| *i != ip);
                                if ips.is_empty() {
                                    snap.remove(&svc_id);
                                }
                            }
                        } // guard dropped here — before .await
                        let _ = tx.send(PodEvent::Changed).await;
                    }
                }
                Ok(Event::Init) => {
                    // Watcher restarted — clear snapshot and rebuild.
                    snapshot.lock().unwrap().clear();
                }
                Ok(Event::InitDone) => {
                    // Initial list complete — trigger a sync.
                    let _ = tx.send(PodEvent::Changed).await;
                }
                Err(e) => {
                    warn!("[pod_watcher] Watcher error: {} — will retry", e);
                }
            }
        }
    }
}

/// Extract the service identity and pod IP from a pod object.
/// Returns `None` if the pod has no `app` label or no assigned IP.
fn extract_service_and_ip(pod: &Pod) -> Option<(String, Ipv4Addr)> {
    let labels = pod.metadata.labels.as_ref()?;
    let svc_id = labels.get("app")?.clone();

    let ip_str = pod
        .status
        .as_ref()?
        .pod_ip
        .as_ref()?
        .as_str();

    let ip: Ipv4Addr = ip_str.parse().ok()?;
    Some((svc_id, ip))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pod(app: &str, ip: &str) -> Pod {
        use k8s_openapi::api::core::v1::PodStatus;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        Pod {
            metadata: ObjectMeta {
                labels: Some(std::collections::BTreeMap::from([
                    ("app".to_string(), app.to_string()),
                ])),
                ..Default::default()
            },
            spec: None,
            status: Some(PodStatus {
                pod_ip: Some(ip.to_string()),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn extract_service_and_ip_ok() {
        let pod = make_pod("service-alpha", "10.244.1.5");
        let result = extract_service_and_ip(&pod);
        assert_eq!(result, Some(("service-alpha".to_string(), "10.244.1.5".parse().unwrap())));
    }

    #[test]
    fn extract_service_and_ip_no_label() {
        use k8s_openapi::api::core::v1::PodStatus;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
        let pod = Pod {
            metadata: ObjectMeta { labels: None, ..Default::default() },
            spec: None,
            status: Some(PodStatus { pod_ip: Some("10.244.1.5".to_string()), ..Default::default() }),
        };
        assert!(extract_service_and_ip(&pod).is_none());
    }

    #[test]
    fn extract_service_and_ip_no_ip() {
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
        let pod = Pod {
            metadata: ObjectMeta {
                labels: Some(std::collections::BTreeMap::from([
                    ("app".to_string(), "service-alpha".to_string()),
                ])),
                ..Default::default()
            },
            spec: None,
            status: None,
        };
        assert!(extract_service_and_ip(&pod).is_none());
    }

    #[test]
    fn snapshot_starts_empty() {
        let w = PodWatcher::new("node-1".to_string());
        assert!(w.snapshot().is_empty());
    }

    #[test]
    fn snapshot_accumulates_pods() {
        let w = PodWatcher::new("node-1".to_string());
        {
            let mut snap = w.snapshot.lock().unwrap();
            snap.entry("service-alpha".to_string())
                .or_default()
                .push("10.244.1.5".parse().unwrap());
            snap.entry("service-beta".to_string())
                .or_default()
                .push("10.244.2.7".parse().unwrap());
        }
        let snap = w.snapshot();
        assert_eq!(snap["service-alpha"], vec!["10.244.1.5".parse::<Ipv4Addr>().unwrap()]);
        assert_eq!(snap["service-beta"],  vec!["10.244.2.7".parse::<Ipv4Addr>().unwrap()]);
    }
}
