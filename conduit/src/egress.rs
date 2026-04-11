// egress.rs — Conduit Egress proxy.
//
// Listens on `listen_addr` (plain TCP, e.g. :9090).
// Each incoming connection:
//   1. Reads the HTTP request line to extract the `Host:` header value.
//   2. Checks PolicyCache::is_allowed_destination(host).
//   3. If allowed, opens a mTLS connection to `peer_addr` (Ingress) and tunnels.
//   4. If denied, responds with 403 and closes.

use crate::tls_config;
use anyhow::Result;
use meshlite_tls::{cert_store::CertStore, policy_cache::PolicyCache};
use rustls::pki_types::ServerName;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

pub async fn run(
    listen_addr: String,
    peer_addr: String,
    cluster_id: String,
    cert_store: Arc<Mutex<CertStore>>,
    policy_cache: Arc<Mutex<PolicyCache>>,
) -> Result<()> {
    let listener = TcpListener::bind(&listen_addr).await?;
    log::info!("[egress] listening on {listen_addr}, peer={peer_addr}");

    loop {
        let (stream, peer) = listener.accept().await?;
        log::debug!("[egress] accepted connection from {peer}");

        let peer_addr = peer_addr.clone();
        let cluster_id = cluster_id.clone();
        let cert_store = Arc::clone(&cert_store);
        let policy_cache = Arc::clone(&policy_cache);

        tokio::spawn(async move {
            if let Err(e) = handle_connection(
                stream, peer_addr, cluster_id, cert_store, policy_cache,
            )
            .await
            {
                log::warn!("[egress] connection error: {e}");
            }
        });
    }
}

async fn handle_connection(
    mut client: TcpStream,
    peer_addr: String,
    _cluster_id: String,
    cert_store: Arc<Mutex<CertStore>>,
    policy_cache: Arc<Mutex<PolicyCache>>,
) -> Result<()> {
    // Read up to 8 KB — enough for any HTTP request header.
    let mut buf = vec![0u8; 8192];
    let n = client.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let header_bytes = &buf[..n];

    // Extract Host header value.
    let destination = match extract_host(header_bytes) {
        Some(h) => h,
        None => {
            client
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                .await?;
            return Ok(());
        }
    };

    // Policy check — destination-based (Phase 4 limitation; source not verified).
    let allowed = {
        let cache = policy_cache.lock().unwrap();
        cache.is_allowed_destination(&destination)
    };
    if !allowed {
        log::info!("[egress] DENY -> {destination}");
        client
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Ok(());
    }
    log::info!("[egress] ALLOW -> {destination}");

    // Build mTLS client config.
    let tls_cfg = {
        let store = cert_store.lock().unwrap();
        let entry = store
            .first_cert()
            .ok_or_else(|| anyhow::anyhow!("no cert in store"))?;
        Arc::new(tls_config::client_config(
            &entry.leaf_cert_pem,
            &entry.private_key_pem,
            &entry.root_ca_pem,
        )?)
    };

    // Connect to ingress with mTLS.
    let connector = TlsConnector::from(tls_cfg);
    // Use "localhost" as SNI: the Sigil enroll-cluster endpoint includes it as
    // a DNS SAN on the issued Conduit cert, so rustls name validation succeeds
    // without needing separate peer-cluster-id plumbing in Phase 4.
    let server_name = ServerName::try_from("localhost")
        .map_err(|e| anyhow::anyhow!("invalid SNI name 'localhost': {e}"))?;
    let upstream_tcp = TcpStream::connect(&peer_addr).await?;
    log::debug!("[egress] TCP connect to {peer_addr} OK");
    let mut upstream = connector.connect(server_name, upstream_tcp).await?;
    log::debug!("[egress] mTLS handshake to {peer_addr} OK");

    // Forward the buffered request header to the upstream.
    upstream.write_all(header_bytes).await?;

    // Bidirectional pipe.
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

/// Extract the value of the `Host:` header from raw HTTP bytes.
/// Returns None if the header is missing or malformed.
fn extract_host(raw: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(raw).ok()?;
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            let value = line["host:".len()..].trim();
            // Strip port if present (e.g. "service-beta:8080").
            let host = value.split(':').next().unwrap_or(value).to_string();
            if !host.is_empty() {
                return Some(host);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_extraction_basic() {
        let raw = b"GET / HTTP/1.1\r\nHost: service-beta\r\nAccept: */*\r\n\r\n";
        assert_eq!(extract_host(raw), Some("service-beta".into()));
    }

    #[test]
    fn host_extraction_with_port() {
        let raw = b"GET / HTTP/1.1\r\nHost: service-beta:8080\r\n\r\n";
        assert_eq!(extract_host(raw), Some("service-beta".into()));
    }

    #[test]
    fn host_extraction_missing() {
        let raw = b"GET / HTTP/1.1\r\nAccept: */*\r\n\r\n";
        assert_eq!(extract_host(raw), None);
    }
}
