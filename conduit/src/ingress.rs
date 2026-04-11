// ingress.rs — Conduit Ingress proxy.
//
// Listens on `listen_addr` with mTLS (TLS server that requires a client cert).
// Each incoming (already-mTLS) connection:
//   1. Reads the HTTP request line to extract the `Host:` header.
//   2. Connects plain TCP to `<host>.meshlite-test.svc.cluster.local:8080`
//      (or the host directly if already fully qualified).
//   3. Tunnels bidirectionally.

use crate::tls_config;
use anyhow::Result;
use meshlite_tls::cert_store::CertStore;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

pub async fn run(
    listen_addr: String,
    cluster_id: String,
    cert_store: Arc<Mutex<CertStore>>,
    svc_domain_suffix: String,
    svc_port: u16,
) -> Result<()> {
    // Build server TLS config from stored certs.
    let tls_cfg = {
        let store = cert_store.lock().unwrap();
        let entry = store
            .first_cert()
            .ok_or_else(|| anyhow::anyhow!("no cert in store for ingress TLS"))?;
        Arc::new(tls_config::server_config(
            &entry.leaf_cert_pem,
            &entry.private_key_pem,
            &entry.root_ca_pem,
        )?)
    };

    let acceptor = TlsAcceptor::from(tls_cfg);
    let listener = TcpListener::bind(&listen_addr).await?;
    log::info!(
        "[ingress] listening on {listen_addr} (mTLS, cluster={cluster_id})"
    );

    loop {
        let (stream, peer) = listener.accept().await?;
        log::debug!("[ingress] accepted TCP from {peer}");

        let acceptor = acceptor.clone();
        let svc_domain_suffix = svc_domain_suffix.clone();
        let svc_port = svc_port;

        tokio::spawn(async move {
            if let Err(e) =
                handle_connection(stream, acceptor, &svc_domain_suffix, svc_port).await
            {
                log::warn!("[ingress] connection error: {e}");
            }
        });
    }
}

async fn handle_connection(
    stream: TcpStream,
    acceptor: TlsAcceptor,
    svc_domain_suffix: &str,
    svc_port: u16,
) -> Result<()> {
    // Complete mTLS handshake.
    let mut tls = acceptor.accept(stream).await?;
    log::debug!("[ingress] mTLS handshake complete");

    // Read HTTP headers (up to 8 KB).
    let mut buf = vec![0u8; 8192];
    let n = tls.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let header_bytes = &buf[..n];

    let host = match extract_host(header_bytes) {
        Some(h) => h,
        None => {
            tls.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                .await?;
            return Ok(());
        }
    };

    // Resolve the backend address.
    let backend_addr = if host.contains('.') {
        // Already fully qualified.
        format!("{host}:{svc_port}")
    } else {
        format!("{host}{svc_domain_suffix}:{svc_port}")
    };
    log::info!("[ingress] routing Host:{host} -> {backend_addr}");

    let mut backend = TcpStream::connect(&backend_addr)
        .await
        .map_err(|e| anyhow::anyhow!("connect to backend {backend_addr}: {e}"))?;

    // Forward buffered headers to backend.
    backend.write_all(header_bytes).await?;

    // Bidirectional pipe.
    tokio::io::copy_bidirectional(&mut tls, &mut backend).await?;
    Ok(())
}

/// Extract the value of the `Host:` header from raw HTTP bytes.
fn extract_host(raw: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(raw).ok()?;
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            let value = line["host:".len()..].trim();
            let host = value.split(':').next().unwrap_or(value).to_string();
            if !host.is_empty() {
                return Some(host);
            }
        }
    }
    None
}
