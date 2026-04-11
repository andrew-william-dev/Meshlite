// tls_config.rs — build rustls ClientConfig and ServerConfig from PEM bytes.
//
// Used by both Egress (client-side TLS toward Ingress) and Ingress
// (server-side TLS accepting connections from Egress).

use anyhow::{Context, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::RootCertStore;
use rustls_pemfile::{certs, ec_private_keys, pkcs8_private_keys};
use std::io::Cursor;
use std::sync::Arc;

/// Build a rustls ClientConfig that:
///   - presents `leaf_cert_pem` / `key_pem` as the client certificate (mTLS)
///   - trusts connections to servers whose chain roots in `root_ca_pem`
pub fn client_config(
    leaf_cert_pem: &[u8],
    key_pem: &[u8],
    root_ca_pem: &[u8],
) -> Result<rustls::ClientConfig> {
    let leaf_certs = load_certs(leaf_cert_pem)?;
    let key = load_key(key_pem)?;
    let root_store = root_store(root_ca_pem)?;

    let config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_client_auth_cert(leaf_certs, key)
        .context("build client TLS config")?;
    Ok(config)
}

/// Build a rustls ServerConfig that:
///   - presents `leaf_cert_pem` / `key_pem` to connecting clients
///   - requires client certificate verified against `root_ca_pem` (mTLS)
pub fn server_config(
    leaf_cert_pem: &[u8],
    key_pem: &[u8],
    root_ca_pem: &[u8],
) -> Result<rustls::ServerConfig> {
    let leaf_certs = load_certs(leaf_cert_pem)?;
    let key = load_key(key_pem)?;
    let root_store = root_store(root_ca_pem)?;

    let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(root_store))
        .build()
        .context("build client verifier")?;

    let config = rustls::ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(leaf_certs, key)
        .context("build server TLS config")?;
    Ok(config)
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn load_certs(pem: &[u8]) -> Result<Vec<CertificateDer<'static>>> {
    let mut cur = Cursor::new(pem);
    certs(&mut cur)
        .collect::<Result<Vec<_>, _>>()
        .context("parse certificate PEM")
}

fn load_key(pem: &[u8]) -> Result<PrivateKeyDer<'static>> {
    let mut cur = Cursor::new(pem);
    if let Some(key) = pkcs8_private_keys(&mut cur).next() {
        return key
            .map(|k| PrivateKeyDer::from(k))
            .context("parse PKCS#8 private key PEM");
    }

    let mut cur = Cursor::new(pem);
    if let Some(key) = ec_private_keys(&mut cur).next() {
        return key
            .map(|k| PrivateKeyDer::from(k))
            .context("parse EC private key PEM");
    }

    Err(anyhow::anyhow!("no supported private key found in PEM"))
}

fn root_store(root_ca_pem: &[u8]) -> Result<RootCertStore> {
    let mut store = RootCertStore::empty();
    let mut cur = Cursor::new(root_ca_pem);
    for cert in certs(&mut cur) {
        let cert = cert.context("parse root CA cert")?;
        store.add(cert).context("add root CA to store")?;
    }
    Ok(store)
}
