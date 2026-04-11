// main.rs — Conduit cross-cluster gateway entrypoint.
//
// Usage:
//   conduit --mode egress  --cluster-id cluster-1 --sigil-addr sigil:8080
//           --listen-addr :9090 --peer-addr <ingress-nodeport>:443
//
//   conduit --mode ingress --cluster-id cluster-2 --sigil-addr sigil:8080
//           --listen-addr :443 --svc-domain-suffix .meshlite-test.svc.cluster.local
//           --svc-port 8080

mod cluster_client;
mod egress;
mod ingress;
mod telemetry;
mod tls_config;

use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use meshlite_tls::{cert_store::CertStore, policy_cache::PolicyCache};
use std::sync::{Arc, Mutex};

#[derive(Clone, ValueEnum, Debug)]
enum Mode {
    Egress,
    Ingress,
}

#[derive(Parser, Debug)]
#[command(author, version, about = "MeshLite Conduit cross-cluster gateway")]
struct Cli {
    /// Operating mode: egress (outbound) or ingress (inbound)
    #[arg(long, env = "CONDUIT_MODE")]
    mode: Mode,

    /// Unique identifier for this cluster (used as CN in TLS cert)
    #[arg(long, env = "CONDUIT_CLUSTER_ID")]
    cluster_id: String,

    /// Sigil REST API address (host:port, plaintext HTTP)
    #[arg(long, env = "CONDUIT_SIGIL_ADDR", default_value = "sigil.meshlite-system.svc.cluster.local:8080")]
    sigil_addr: String,

    /// Address to listen on
    #[arg(long, env = "CONDUIT_LISTEN_ADDR", default_value = ":9090")]
    listen_addr: String,

    /// [Egress only] Address of the remote Ingress (host:port)
    #[arg(long, env = "CONDUIT_PEER_ADDR", default_value = "")]
    peer_addr: String,

    /// [Ingress only] DNS suffix appended to bare service names for backend lookup
    #[arg(long, env = "CONDUIT_SVC_DOMAIN_SUFFIX", default_value = ".meshlite-test.svc.cluster.local")]
    svc_domain_suffix: String,

    /// [Ingress only] Port on which backend services listen
    #[arg(long, env = "CONDUIT_SVC_PORT", default_value_t = 8080)]
    svc_port: u16,

    /// Trace API URL for telemetry emission.
    #[arg(long, env = "CONDUIT_TRACE_URL", default_value = "http://trace.meshlite-system.svc.cluster.local:3000")]
    trace_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    env_logger::init();
    let cli = Cli::parse();

    log::info!(
        "[conduit] starting mode={:?} cluster_id={} sigil={}",
        cli.mode,
        cli.cluster_id,
        cli.sigil_addr
    );

    // ── Step 1: Enroll with Sigil ─────────────────────────────────────────────
    log::info!("[conduit] enrolling with Sigil at {}", cli.sigil_addr);
    let enroll_resp = cluster_client::enroll(&cli.sigil_addr, &cli.cluster_id)
        .await
        .context("enroll with Sigil")?;
    log::info!("[conduit] enrollment OK — cert received");

    // ── Step 2: Populate CertStore ────────────────────────────────────────────
    let cert_store = Arc::new(Mutex::new(CertStore::new()));
    {
        let mut store = cert_store.lock().unwrap();
        cluster_client::apply_enroll(&mut store, &enroll_resp, &cli.cluster_id);
    }

    // ── Step 3: Initial policy fetch + start poll ─────────────────────────────
    let policy_cache = Arc::new(Mutex::new(PolicyCache::new()));
    cluster_client::start_policy_poll(cli.sigil_addr.clone(), Arc::clone(&policy_cache));
    let telemetry = telemetry::start(cli.trace_url.clone(), "conduit");

    // ── Step 4: Run the proxy ─────────────────────────────────────────────────
    let listen_addr = normalize_listen_addr(&cli.listen_addr);
    match cli.mode {
        Mode::Egress => {
            if cli.peer_addr.is_empty() {
                anyhow::bail!("--peer-addr is required in egress mode");
            }
            egress::run(
                listen_addr,
                cli.peer_addr,
                cli.cluster_id,
                cert_store,
                policy_cache,
                telemetry,
            )
            .await?;
        }
        Mode::Ingress => {
            ingress::run(
                listen_addr,
                cli.cluster_id,
                cert_store,
                cli.svc_domain_suffix,
                cli.svc_port,
                telemetry,
            )
            .await?;
        }
    }

    Ok(())
}

fn normalize_listen_addr(addr: &str) -> String {
    if addr.starts_with(':') {
        format!("0.0.0.0{addr}")
    } else {
        addr.to_string()
    }
}
