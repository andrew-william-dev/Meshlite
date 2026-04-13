import { useEffect, useMemo, useState } from "react";

const repoApi = "https://api.github.com/repos/andrew-william-dev/Meshlite/releases/latest";

function LatestRelease() {
  const [state, setState] = useState({ loading: true, data: null, error: "" });

  useEffect(() => {
    let active = true;

    async function loadLatestRelease() {
      try {
        const response = await fetch(repoApi, {
          headers: {
            Accept: "application/vnd.github+json",
          },
        });

        if (!response.ok) {
          throw new Error("Release API returned " + response.status);
        }

        const release = await response.json();
        if (!active) {
          return;
        }

        setState({ loading: false, data: release, error: "" });
      } catch (err) {
        if (!active) {
          return;
        }

        setState({ loading: false, data: null, error: String(err.message || err) });
      }
    }

    loadLatestRelease();
    return () => {
      active = false;
    };
  }, []);

  const meshctlAsset = useMemo(() => {
    if (!state.data?.assets) {
      return null;
    }
    return state.data.assets.find((asset) => asset.name.toLowerCase().includes("meshctl") && asset.name.toLowerCase().includes("windows"));
  }, [state.data]);

  if (state.loading) {
    return <p className="release-note">Fetching latest GitHub release...</p>;
  }

  if (state.error) {
    return <p className="release-note">Could not fetch release metadata: {state.error}</p>;
  }

  return (
    <div className="release-card release-card-pro">
      <p className="release-kicker">Latest meshctl</p>
      <h3>{state.data.tag_name || "unknown"}</h3>
      <p className="release-meta">Published {new Date(state.data.published_at).toLocaleDateString()}</p>
      <p>{state.data.assets?.length || 0} release assets are currently available.</p>
      {meshctlAsset && (
        <a href={meshctlAsset.browser_download_url} target="_blank" rel="noreferrer">
          Download meshctl (Windows)
        </a>
      )}
    </div>
  );
}

function HomePage({ onDocsClick }) {
  return (
    <main className="home-main">
      <section className="hero hero-pro">
        <div className="hero-noise" />
        <div className="hero-spotlight" />
        <div className="container hero-layout">
          <div className="hero-copy-pane pro-panel">
            <p className="hero-kicker">Kubernetes Service Mesh Security Platform</p>
            <h1>Ship runtime policy, identity, and traffic proof without heavyweight mesh complexity.</h1>
            <p className="hero-copy">
              MeshLite is an operator-first runtime platform: Sigil controls identity and policy, Conduit enforces cross-cluster
              boundaries, Trace provides journey-level evidence, and meshctl gives fast operational control from any terminal.
            </p>
            <div className="hero-actions">
              <button className="btn btn-primary" onClick={onDocsClick}>
                Documentation
              </button>
              <a className="btn btn-ghost" href="https://github.com/andrew-william-dev/Meshlite" target="_blank" rel="noreferrer">
                GitHub repository
              </a>
            </div>
            <div className="hero-metrics">
              <div>
                <strong>8 services / 10 edges</strong>
                <span>Live topology proven in Phase 5</span>
              </div>
              <div>
                <strong>ALLOW + DENY verified</strong>
                <span>meshctl verify against live policy</span>
              </div>
              <div>
                <strong>Cross-cluster p99 +7.151ms</strong>
                <span>Measured on kind in Phase 4 report</span>
              </div>
            </div>
          </div>

          <div className="hero-stage pro-panel" aria-hidden="true">
            <div className="stage-grid" />
            <div className="mesh-card sigil-card">
              <h4>Sigil</h4>
              <p>Identity and policy authority</p>
            </div>
            <div className="mesh-card conduit-card">
              <h4>Conduit</h4>
              <p>Cross-cluster enforcement boundary</p>
            </div>
            <div className="mesh-card trace-card">
              <h4>Trace</h4>
              <p>Runtime telemetry and journey evidence</p>
            </div>
            <div className="wire wire-a" />
            <div className="wire wire-b" />
            <div className="wire wire-c" />
          </div>
        </div>
      </section>

      <section className="container showcase-grid" aria-label="Product portfolio">
        <article className="pro-panel">
          <h3>Control plane confidence</h3>
          <p>Centralized identity and policy distribution with explicit runtime intent and fast rollout paths.</p>
        </article>
        <article className="pro-panel">
          <h3>Data plane enforcement</h3>
          <p>Conduit egress and ingress enforce boundary policy decisions and classify cross-cluster behavior.</p>
        </article>
        <article className="pro-panel">
          <h3>Operator evidence</h3>
          <p>Trace renders allow and deny events, service topology, and latency streams for fast incident triage.</p>
        </article>
        <article className="pro-panel">
          <h3>CLI operations</h3>
          <p>meshctl supports apply, status, verify, logs, rotate, and version in a no-Go installed workflow.</p>
        </article>
      </section>

      <section className="container split-section">
        <div className="pro-panel">
          <h2>What teams get with MeshLite</h2>
          <ol>
            <li>Policy-backed service communication from day one.</li>
            <li>Cross-cluster request enforcement through Conduit boundary controls.</li>
            <li>Operator observability that connects policy intent with runtime outcomes.</li>
            <li>Fast operational loops through meshctl and Helm-managed deployment paths.</li>
          </ol>
        </div>
        <div className="pro-panel pricing-placeholder">
          <h3>Commercial packaging ready</h3>
          <p>
            Architecture and docs are structured for future pricing tiers, enterprise hardening, and managed-service packaging.
          </p>
          <ul>
            <li>Core platform footprint</li>
            <li>Operational visibility modules</li>
            <li>Enterprise controls (future)</li>
          </ul>
        </div>
      </section>

      <section className="container release-row">
        <LatestRelease />
      </section>
    </main>
  );
}

function DocsPage() {
  return (
    <main className="docs-main container">
      <aside className="docs-sidebar pro-panel">
        <h3>Docs navigation</h3>
        <a href="#start-here">Start here</a>
        <a href="#helm-quickstart">Helm quickstart</a>
        <a href="#helm-values">Helm values model</a>
        <a href="#meshctl-install">meshctl install</a>
        <a href="#meshctl-ops">meshctl operations</a>
        <a href="#runtime-explained">Runtime explained</a>
        <a href="#proof">Proof from outcome reports</a>
      </aside>

      <article className="docs-article pro-panel">
        <section id="start-here">
          <h2>Start here</h2>
          <p>
            MeshLite is delivered as an umbrella Helm chart plus a standalone meshctl CLI. Helm installs platform components and
            meshctl drives operational tasks. This documentation maps to your current alpha architecture and validated outcome
            reports.
          </p>
          <ol>
            <li>Install or upgrade MeshLite with Helm.</li>
            <li>Install meshctl globally from GitHub release assets.</li>
            <li>Run meshctl status and verify for control-plane confidence.</li>
            <li>Use Trace to inspect live request outcomes and topology.</li>
          </ol>
        </section>

        <section id="helm-quickstart">
          <h2>Helm quickstart</h2>
          <p>Install the platform with the umbrella chart, then layer environment-specific values files when needed.</p>
          <pre className="codeblock block-code">
            <code>{`helm upgrade --install meshlite ./charts/meshlite \
  --namespace meshlite-system \
  --create-namespace`}</code>
          </pre>
          <p>
            For multi-cluster lab setups, selectively enable conduit egress or ingress and set cluster IDs in per-cluster values
            files.
          </p>
        </section>

        <section id="helm-values">
          <h2>Helm values model</h2>
          <p>Primary values sections in charts/meshlite/values.yaml:</p>
          <ul>
            <li>global.imageTag: shared release tag override</li>
            <li>sigil.enabled and sigil.config: control-plane policy source and CA behavior</li>
            <li>kprobe.cluster.id plus kprobe.sigil and kprobe.trace addresses</li>
            <li>conduitEgress and conduitIngress: mode, peer address, and cluster identity</li>
            <li>trace.enabled and trace.ingress settings for internal access patterns</li>
            <li>demo.*: optional validator workloads for guided platform demos</li>
          </ul>
        </section>

        <section id="meshctl-install">
          <h2>meshctl install (no Go required)</h2>
          <p>meshctl is released as platform binaries. Install once and run from any terminal.</p>
          <pre className="codeblock block-code">
            <code>{`# Linux/macOS
curl -sSfL <install-url> | sh

# Windows PowerShell
irm <install-url> | iex`}</code>
          </pre>
        </section>

        <section id="meshctl-ops">
          <h2>meshctl operations</h2>
          <pre className="codeblock block-code">
            <code>{`meshctl version
meshctl status --sigil-url http://127.0.0.1:8080 --trace-url http://127.0.0.1:3000
meshctl verify --from service-a --to service-b --sigil-url http://127.0.0.1:8080
meshctl apply -f policy.yaml --sigil-url http://127.0.0.1:8080
meshctl logs --trace-url http://127.0.0.1:3000`}</code>
          </pre>
          <p>
            Typical workflow: status for health, apply for policy rollout, verify for predictive decisions, logs for live
            visibility.
          </p>
        </section>

        <section id="runtime-explained">
          <h2>What happens at runtime</h2>
          <p>
            Request paths are evaluated by Sigil policy, enforced by Kprobe and Conduit depending on traffic leg, and emitted to
            Trace for operator evidence.
          </p>
          <ul>
            <li>Identity: Sigil issues and rotates cert-backed service identity.</li>
            <li>Policy: allow and deny rules resolve before continuation.</li>
            <li>Enforcement: same-cluster and cross-cluster paths apply explicit controls.</li>
            <li>Visibility: Trace summary, topology, and events close the operator loop.</li>
          </ul>
        </section>

        <section id="proof">
          <h2>Proof from outcome reports</h2>
          <ul>
            <li>Phase 5 verified topology API with 8 services and 10 edges.</li>
            <li>Phase 5 validated ALLOW and DENY predictions through meshctl verify.</li>
            <li>Phase 4 validated cross-cluster enforcement with mTLS boundary checks.</li>
            <li>Phase 4 measured kind-lab cross-cluster p99 overhead at +7.151ms.</li>
          </ul>
        </section>
      </article>
    </main>
  );
}

export default function App() {
  const [tab, setTab] = useState("home");

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">MeshLite</div>
        <nav className="main-nav">
          <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>
            Home
          </button>
          <button className={tab === "docs" ? "active" : ""} onClick={() => setTab("docs")}>
            Documentation
          </button>
        </nav>
      </header>

      {tab === "home" ? <HomePage onDocsClick={() => setTab("docs")} /> : <DocsPage />}

      <footer>
        <p>MeshLite alpha platform | Product portfolio preview and operator documentation</p>
      </footer>
    </div>
  );
}
