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
          Download first meshctl asset
        </a>
      )}
    </div>
  );
}

function HomePage({ onDocsClick }) {
  return (
    <main>
      <section className="hero">
        <div className="hero-glow" />
        <div className="hero-grid" />
        <div className="hero-content">
          <p className="hero-kicker">Runtime Security Mesh | Alpha</p>
          <h1>Policy-first service connectivity without heavy platform tax.</h1>
          <p className="hero-copy">
            MeshLite combines identity, traffic policy, and observability into a compact control plane. You get cross-cluster
            safety controls, TLS-backed service trust, and traceable decisions in one operator workflow.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={onDocsClick}>
              Read docs
            </button>
            <a className="btn btn-ghost" href="https://github.com/andrew-william-dev/Meshlite" target="_blank" rel="noreferrer">
              View GitHub
            </a>
          </div>
        </div>
      </section>

      <section className="value-grid" aria-label="MeshLite capabilities">
        <article>
          <h3>Sigil control plane</h3>
          <p>Issue service identities, distribute policy, and keep mTLS intent centralized.</p>
        </article>
        <article>
          <h3>Conduit enforcement</h3>
          <p>Enforce runtime decisions at traffic boundaries with clear allow and deny telemetry.</p>
        </article>
        <article>
          <h3>Trace visibility</h3>
          <p>Follow journeys from source to destination and inspect latency and verdict streams.</p>
        </article>
      </section>

      <section className="how">
        <h2>How MeshLite works</h2>
        <ol>
          <li>Define policy and identities in Sigil.</li>
          <li>Conduit enforces traffic behavior at runtime.</li>
          <li>Trace records outcomes so operators verify posture quickly.</li>
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
        <a href="#quickstart">Quickstart</a>
        <a href="#what-happens">What happens under the hood</a>
        <a href="#meshctl">meshctl guide</a>
      </aside>

      <article>
        <section id="quickstart">
          <h2>Quickstart</h2>
          <ol>
            <li>Create dev clusters and install MeshLite components.</li>
            <li>Apply sample workload manifests.</li>
            <li>Use meshctl status and meshctl verify to inspect live policy decisions.</li>
            <li>Open Trace to review request flow, latency, and verdicts.</li>
          </ol>
        </section>

        <section id="what-happens">
          <h2>What happens in runtime</h2>
          <p>
            Each request path is evaluated by policy from Sigil, then enforced by Conduit. Trace receives the decision and timing
            metadata so you can audit the outcome and tune policy with confidence.
          </p>
          <ul>
            <li>Identity: Service certificates establish caller and destination trust.</li>
            <li>Policy: Allow and deny rules are resolved before traffic continuation.</li>
            <li>Visibility: Request verdicts and latency become queryable operational signals.</li>
          </ul>
        </section>

        <section id="meshctl">
          <h2>meshctl usage</h2>
          <p>Install the CLI once from release artifacts, then use these core commands:</p>
          <div className="codeblock">
            <p>meshctl version</p>
            <p>meshctl status --sigil-url http://127.0.0.1:8080 --trace-url http://127.0.0.1:3000</p>
            <p>meshctl verify --from service-a --to service-b --sigil-url http://127.0.0.1:8080</p>
            <p>meshctl logs --trace-url http://127.0.0.1:3000</p>
          </div>
          <p>
            For policy updates, use meshctl apply with a policy file to push changes to Sigil, then re-run verify to validate new
            behavior.
          </p>
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
