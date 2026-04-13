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
    return state.data.assets.find((asset) => asset.name.toLowerCase().includes("meshctl"));
  }, [state.data]);

  if (state.loading) {
    return <p className="release-note">Fetching latest GitHub release...</p>;
  }

  if (state.error) {
    return <p className="release-note">Could not fetch release metadata: {state.error}</p>;
  }

  return (
    <div className="release-card">
      <p className="release-kicker">Latest meshctl release</p>
      <h3>{state.data.tag_name}</h3>
      <p>
        Published {new Date(state.data.published_at).toLocaleDateString()} with {state.data.assets?.length || 0} assets.
      </p>
      {meshctlAsset && (
        <a href={meshctlAsset.browser_download_url} target="_blank" rel="noreferrer">
          Download meshctl binary
        </a>
      )}
    </div>
  );
}

function HomePage({ onDocsClick }) {
  return (
    <main>
      <section className="hero hero-3d">
        <div className="hero-glow" />
        <div className="hero-grid" />
        <div className="hero-content">
          <div className="hero-copy-pane">
            <p className="hero-kicker">Runtime Security Mesh | Alpha</p>
            <h1>Security policy, identity, and observability in one lightweight mesh plane.</h1>
            <p className="hero-copy">
              MeshLite gives teams a focused runtime security stack: Sigil for policy and identity, Conduit for enforcement,
              Trace for high-signal visibility, and meshctl for day-two operations.
            </p>
          </div>

          <div className="hero-scene" aria-hidden="true">
            <div className="orbit orbit-a" />
            <div className="orbit orbit-b" />
            <div className="node node-sigil">Sigil</div>
            <div className="node node-conduit">Conduit</div>
            <div className="node node-trace">Trace</div>
            <div className="beam beam-1" />
            <div className="beam beam-2" />
          </div>
        </div>

        <div className="hero-actions hero-actions-wide">
          <button className="btn btn-primary" onClick={onDocsClick}>
            Read docs
          </button>
          <a className="btn btn-ghost" href="https://github.com/andrew-william-dev/Meshlite" target="_blank" rel="noreferrer">
            View GitHub
          </a>
        </div>
      </section>

      <section className="value-grid" aria-label="MeshLite capabilities">
        <article>
          <h3>Sigil control plane</h3>
          <p className="hero-copy">
            Issue service identities, distribute policy, and keep mTLS trust anchored to explicit runtime intent.
          </p>
        </article>
        <article>
          <h3>Conduit enforcement</h3>
          <p>Enforce allow and deny decisions on live service traffic with policy-first boundary checks.</p>
        </article>
        <article>
          <h3>Trace visibility</h3>
          <p>Follow request journeys with latency, verdict, and cross-cluster context for rapid verification.</p>
        </article>
        <article>
          <h3>meshctl operations</h3>
          <p>Install globally and run status, verify, apply, logs, and rotate commands from any terminal.</p>
        </article>
      </section>

      <section className="how platform-sequence">
        <h2>Runtime sequence</h2>
        <ol>
          <li>Install the Helm chart and bring up Sigil, Conduit, and Trace.</li>
          <li>Apply service policy and identity rules via meshctl.</li>
          <li>Conduit enforces in-band and streams verdict metadata to Trace.</li>
          <li>Operators validate behavior with meshctl verify and dashboard evidence.</li>
        </ol>
      </section>

      <section className="release-wrap">
        <LatestRelease />
      </section>
    </main>
  );
}

function DocsPage() {
  return (
    <main className="docs-layout">
      <aside>
        <h3>Documentation</h3>
        <a href="#overview">Overview</a>
        <a href="#helm-install">Helm install</a>
        <a href="#helm-structure">Helm values structure</a>
        <a href="#meshctl-install">meshctl install</a>
        <a href="#meshctl-commands">meshctl commands</a>
        <a href="#runtime-flow">What happens at runtime</a>
      </aside>

      <article>
        <section id="overview">
          <h2>MeshLite quickstart overview</h2>
          <ol>
            <li>Install MeshLite platform components using Helm.</li>
            <li>Install meshctl globally from release artifacts.</li>
            <li>Use meshctl to inspect policy and verify service paths.</li>
            <li>Use Trace UI to inspect live request outcomes and latency.</li>
          </ol>
        </section>

        <section id="helm-install">
          <h2>Install MeshLite with Helm</h2>
          <p>Start with the umbrella chart and enable the platform components you need for each environment.</p>
          <pre className="codeblock">
            <code>{`helm upgrade --install meshlite ./charts/meshlite \
  --namespace meshlite-system \
  --create-namespace`}</code>
          </pre>
          <p>
            For split-cluster lab setups, use example values files and selective enables so cluster-1 and cluster-2 run the
            expected control and data components.
          </p>
        </section>

        <section id="helm-structure">
          <h2>Helm values structure</h2>
          <p>Core sections in the chart values:</p>
          <ul>
            <li>sigil: control plane and CA settings</li>
            <li>conduitEgress and conduitIngress: cross-cluster traffic enforcement surfaces</li>
            <li>trace: runtime visibility and event APIs</li>
            <li>kprobe: runtime capture and kernel-level event integration</li>
            <li>demo: optional validator demo workloads for guided flows</li>
          </ul>
          <p>
            This structure lets operators keep one install surface while tailoring behavior per environment using values files.
          </p>
        </section>

        <section id="meshctl-install">
          <h2>Install meshctl (no Go required)</h2>
          <p>Install once, then run from any terminal:</p>
          <pre className="codeblock">
            <code>{`# Linux/macOS
curl -sSfL <install-script-url> | sh

# Windows PowerShell
irm <install-script-url> | iex`}</code>
          </pre>
          <p>
            meshctl is distributed as release binaries. Users do not need the MeshLite source repo or Go toolchain to operate the
            platform.
          </p>
        </section>

        <section id="meshctl-commands">
          <h2>meshctl command guide</h2>
          <pre className="codeblock">
            <code>{`meshctl version
meshctl status --sigil-url http://127.0.0.1:8080 --trace-url http://127.0.0.1:3000
meshctl verify --from service-a --to service-b --sigil-url http://127.0.0.1:8080
meshctl apply -f policy.yaml --sigil-url http://127.0.0.1:8080
meshctl logs --trace-url http://127.0.0.1:3000`}</code>
          </pre>
          <p>
            Typical flow: run status to check health, apply policy updates, run verify for preflight decisions, then inspect logs
            and Trace for runtime outcomes.
          </p>
        </section>

        <section id="runtime-flow">
          <h2>What happens at runtime</h2>
          <p>
            A request path is evaluated against policy in Sigil, enforced in Conduit, and emitted as telemetry to Trace. This
            closes the loop between policy intent and observed runtime behavior.
          </p>
          <ul>
            <li>Identity: cert-backed service trust with explicit caller and destination identity.</li>
            <li>Policy: allow and deny decisions resolved before traffic continuation.</li>
            <li>Enforcement: Conduit applies policy on the data path.</li>
            <li>Visibility: Trace stores verdict and latency signals for operators.</li>
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
        <nav>
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
        <p>MeshLite alpha | Policy-first runtime security mesh</p>
      </footer>
    </div>
  );
}
