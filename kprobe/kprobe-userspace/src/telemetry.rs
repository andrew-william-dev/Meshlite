use anyhow::{anyhow, Result};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

#[derive(Clone, Debug, Serialize)]
pub struct TelemetryRecord {
    pub source_service: String,
    pub destination_service: String,
    pub cluster_id: String,
    pub leg: String,
    pub verdict: String,
    pub latency_ms: f64,
    pub tls_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}

#[derive(Clone)]
pub struct TelemetryHandle {
    tx: mpsc::Sender<TelemetryRecord>,
}

pub fn start(trace_url: String, component: &'static str) -> TelemetryHandle {
    let trace_url = trace_url.trim_end_matches('/').to_string();
    let (tx, mut rx) = mpsc::channel::<TelemetryRecord>(512);

    tokio::spawn(async move {
        while let Some(record) = rx.recv().await {
            if let Err(e) = post_record(&trace_url, &record).await {
                log::debug!("[{component}] telemetry send failed: {e}");
            }
        }
    });

    TelemetryHandle { tx }
}

impl TelemetryHandle {
    pub fn emit(&self, record: TelemetryRecord) {
        let _ = self.tx.try_send(record);
    }
}

async fn post_record(base_url: &str, record: &TelemetryRecord) -> Result<()> {
    let addr = base_url
        .strip_prefix("http://")
        .or_else(|| base_url.strip_prefix("https://"))
        .unwrap_or(base_url)
        .trim_end_matches('/');
    let host_port = addr.split('/').next().unwrap_or(addr);
    let body = serde_json::to_vec(record)?;

    let mut stream = TcpStream::connect(host_port).await?;
    let req = format!(
        "POST /api/v1/telemetry HTTP/1.1\r\nHost: {host_port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(req.as_bytes()).await?;
    stream.write_all(&body).await?;

    let mut resp = Vec::new();
    stream.read_to_end(&mut resp).await?;
    let status_end = resp.iter().position(|b| *b == b'\n').unwrap_or(resp.len());
    let status_line = std::str::from_utf8(&resp[..status_end]).unwrap_or("").trim();
    if !(status_line.contains(" 200 ") || status_line.contains(" 202 ")) {
        return Err(anyhow!("unexpected Trace response: {status_line}"));
    }
    Ok(())
}
