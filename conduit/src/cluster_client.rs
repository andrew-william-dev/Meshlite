// cluster_client.rs — Sigil REST client for Conduit.
//
// Responsibilities:
//   1. Enroll this Conduit instance with Sigil via POST /api/v1/enroll-cluster
//      and return the issued TLS credentials.
//   2. Poll GET /api/v1/policy and update the shared PolicyCache on change.

use anyhow::{anyhow, Context, Result};
use meshlite_tls::{
    cert_store::CertStore,
    policy_cache::{AllowRule, PolicyCache},
};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tokio::time::{interval, Duration};

// ── Enroll response ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct EnrollResponse {
    pub cert_pem:        String,
    pub key_pem:         String,
    pub root_ca_pem:     String,
    #[allow(dead_code)]
    pub expires_at_unix: i64,
}

// ── Policy response ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PolicyResponse {
    mtls_mode:     String,
    default_allow: bool,
    rules:         Vec<RemoteRule>,
}

#[derive(Deserialize)]
struct RemoteRule {
    from: String,
    to:   Vec<String>,
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Call POST /api/v1/enroll-cluster on Sigil and return the cert bundle.
///
/// Uses a plain HTTP/1.1 request over tokio TCP (no hyper/reqwest dependency).
pub async fn enroll(sigil_http_addr: &str, cluster_id: &str) -> Result<EnrollResponse> {
    let body = format!(r#"{{"cluster_id":"{}"}}"#, cluster_id);
    let response_bytes =
        http_post(sigil_http_addr, "/api/v1/enroll-cluster", body.as_bytes()).await?;
    serde_json::from_slice(&response_bytes)
        .context("parse enroll-cluster response")
}

/// Populate a CertStore from an EnrollResponse.
///
/// The cluster_id is used as the service identity key inside the store so that
/// conduit's TLS layer can look up the leaf cert by the same name.
pub fn apply_enroll(store: &mut CertStore, resp: &EnrollResponse, cluster_id: &str) {
    store.update(
        cluster_id,
        resp.cert_pem.as_bytes().to_vec(),
        resp.root_ca_pem.as_bytes().to_vec(),
        resp.key_pem.as_bytes().to_vec(),
    );
}

/// Spawn a background task that polls GET /api/v1/policy every 5 s and keeps
/// the shared PolicyCache up to date.
pub fn start_policy_poll(
    sigil_http_addr: String,
    cache: Arc<Mutex<PolicyCache>>,
) {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(5));
        loop {
            ticker.tick().await;
            match fetch_policy(&sigil_http_addr).await {
                Ok(snap) => {
                    let mut c = cache.lock().unwrap();
                    c.update(snap.rules, snap.default_allow, snap.mtls_mode);
                }
                Err(e) => {
                    log::warn!("[conduit] policy poll failed: {e}");
                }
            }
        }
    });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

struct PolicySnapshot {
    mtls_mode:     String,
    default_allow: bool,
    rules:         Vec<AllowRule>,
}

async fn fetch_policy(sigil_http_addr: &str) -> Result<PolicySnapshot> {
    let bytes = http_get(sigil_http_addr, "/api/v1/policy").await?;
    let resp: PolicyResponse =
        serde_json::from_slice(&bytes).context("parse policy response")?;
    let rules = resp
        .rules
        .into_iter()
        .map(|r| AllowRule {
            from_service: r.from,
            to_services:  r.to,
        })
        .collect();
    Ok(PolicySnapshot {
        mtls_mode:     resp.mtls_mode,
        default_allow: resp.default_allow,
        rules,
    })
}

/// Minimal HTTP/1.1 GET over a plain tokio TCP stream.
async fn http_get(addr: &str, path: &str) -> Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let host = addr.split(':').next().unwrap_or(addr);
    let mut stream = TcpStream::connect(addr)
        .await
        .with_context(|| format!("connect to {addr}"))?;

    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await?;

    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await?;
    extract_body(buf)
}

/// Minimal HTTP/1.1 POST over a plain tokio TCP stream.
async fn http_post(addr: &str, path: &str, body: &[u8]) -> Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let host = addr.split(':').next().unwrap_or(addr);
    let mut stream = TcpStream::connect(addr)
        .await
        .with_context(|| format!("connect to {addr}"))?;

    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(req.as_bytes()).await?;
    stream.write_all(body).await?;

    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await?;
    extract_body(buf)
}

/// Strip the HTTP/1.1 response headers and return only the body bytes.
///
/// Handles both `\r\n\r\n` (standard) and `\n\n` (loose) header terminator.
fn extract_body(raw: Vec<u8>) -> Result<Vec<u8>> {
    // Find \r\n\r\n or \n\n
    let sep = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|p| p + 4)
        .or_else(|| {
            raw.windows(2)
                .position(|w| w == b"\n\n")
                .map(|p| p + 2)
        })
        .ok_or_else(|| anyhow!("HTTP response has no header terminator"))?;

    let status_line = std::str::from_utf8(&raw[..raw.iter().position(|&b| b == b'\n').unwrap_or(raw.len())])
        .unwrap_or("")
        .trim();
    if !status_line.contains("200") {
        return Err(anyhow!("HTTP error: {status_line}"));
    }

    Ok(raw[sep..].to_vec())
}
