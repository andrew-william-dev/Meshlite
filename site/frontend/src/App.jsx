import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const GITHUB_API = "https://api.github.com/repos/andrew-william-dev/Meshlite/releases/latest";

function useLatestRelease() {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let active = true;
    fetch(GITHUB_API, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => { if (active) setState({ loading: false, data, error: null }); })
      .catch((e) => { if (active) setState({ loading: false, data: null, error: e.message }); });
    return () => { active = false; };
  }, []);
  return state;
}

// ─── Doc nav context (lets doc pages navigate without prop drilling) ──────────
const DocNavContext = createContext(() => {});

// ─── Callout box ──────────────────────────────────────────────────────────────
function Callout({ type = "note", children }) {
  const META = {
    tip:       { icon: "💡", label: "Tip" },
    note:      { icon: "ℹ",  label: "Note" },
    warning:   { icon: "⚠",  label: "Warning" },
    important: { icon: "★",  label: "Important" },
  };
  const m = META[type] || META.note;
  return (
    <div className={`callout callout-${type}`}>
      <span className="callout-icon">{m.icon}</span>
      <div className="callout-content">
        <strong className="callout-label">{m.label}</strong>
        <div className="callout-body">{children}</div>
      </div>
    </div>
  );
}

// ─── Continue reading / next-steps strip ─────────────────────────────────────
function NextSteps({ items }) {
  const navigate = useContext(DocNavContext);
  return (
    <div className="next-steps">
      <span className="next-steps-label">Continue reading</span>
      <div className="next-steps-grid">
        {items.map(({ id, title, desc }) => (
          <button
            key={id}
            className="next-step-card"
            onClick={() => { navigate(id); window.scrollTo(0, 0); }}
          >
            <span className="nsc-arrow">→</span>
            <div>
              <strong>{title}</strong>
              {desc && <span>{desc}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Numbered step row ────────────────────────────────────────────────────────
function DocStep({ num, title, children }) {
  return (
    <div className="doc-step">
      <span className="step-num">{num}</span>
      <div className="step-content">
        {title && <h4>{title}</h4>}
        {children}
      </div>
    </div>
  );
}

// ─── Prerequisites bar ────────────────────────────────────────────────────────
function DocPrereqs({ items }) {
  return (
    <div className="doc-prereqs">
      <span className="doc-prereq-label">Prerequisites</span>
      {items.map((item) => (
        <span key={item} className="doc-prereq">✓ {item}</span>
      ))}
    </div>
  );
}

// ─── Hero Topology Canvas ─────────────────────────────────────────────────────
// Shows the 4 MeshLite components (Sigil center + 3 satellites) with animated
// data-flow particles on each edge. Sigil has two orbiting rings to indicate
// its role as the CA. Background starfield adds depth.
function TopologyCanvas() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let animId;
    const W = canvas.clientWidth || 540;
    const H = canvas.clientHeight || 460;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(44, W / H, 0.1, 100);
    camera.position.set(0, 0.5, 9.5);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);

    // Lighting — ambient + teal point light pulsing from Sigil center
    scene.add(new THREE.AmbientLight(0x334466, 0.75));
    const sigilLight = new THREE.PointLight(0x3dd68c, 2.2, 11);
    sigilLight.position.set(0, 0, 2);
    scene.add(sigilLight);

    const group = new THREE.Group();
    scene.add(group);

    // Starfield (not in group so it rotates slower via separate assignment)
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(900);
    for (let i = 0; i < 900; i += 3) {
      starPos[i]     = (Math.random() - 0.5) * 28;
      starPos[i + 1] = (Math.random() - 0.5) * 22;
      starPos[i + 2] = (Math.random() - 0.5) * 8 - 6;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starField = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x3a5a70, size: 0.05, transparent: true, opacity: 0.55 }));
    scene.add(starField);

    // [x, y, z, hexColor, radius, isComponent]
    const NODES = [
      [ 0,    0,    0,    0x3dd68c, 0.30, true],   // 0 Sigil  — CA, center
      [-2.2, -1.1,  0.3,  0xf97e6f, 0.20, true],   // 1 Kprobe — eBPF enforcer
      [ 2.2, -1.1, -0.3,  0xb898ff, 0.20, true],   // 2 Conduit— cross-cluster gateway
      [ 0,    2.4,  0,    0x4ade9e, 0.18, true],   // 3 Trace  — observability
      [-3.6,  0.8,  0.6,  0x1e3d58, 0.09, false],  // pods
      [-1.8, -3.0, -0.3,  0x1e3d58, 0.09, false],
      [ 0.5, -2.9,  0.7,  0x1e3d58, 0.09, false],
      [ 3.4,  0.5, -0.5,  0x1e3d58, 0.09, false],
      [ 2.5, -2.7,  0.5,  0x1e3d58, 0.09, false],
    ];

    const meshes = NODES.map(([x, y, z, col, r, isC]) => {
      const geo = new THREE.SphereGeometry(r, isC ? 24 : 10, isC ? 24 : 10);
      const mat = new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: isC ? 0.55 : 0.25 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      group.add(mesh);
      if (isC) {
        const hg = new THREE.SphereGeometry(r * 3.4, 12, 12);
        const hm = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.06 });
        const halo = new THREE.Mesh(hg, hm);
        halo.position.set(x, y, z);
        group.add(halo);
      }
      return mesh;
    });

    // Sigil gets two orbiting torus rings — signals its role as the CA
    const mkRing = (radius, tube, opacity, rotX) => {
      const geo = new THREE.TorusGeometry(radius, tube, 8, 90);
      const mat = new THREE.MeshBasicMaterial({ color: 0x3dd68c, transparent: true, opacity });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = rotX;
      group.add(mesh);
      return mesh;
    };
    const ring1 = mkRing(0.70, 0.017, 0.50, 1.1);
    const ring2 = mkRing(1.02, 0.009, 0.18, 0.75);

    const vecs = NODES.map(d => new THREE.Vector3(d[0], d[1], d[2]));

    // Component-to-component edges with semantic colors
    const COMP_EDGES = [
      [0, 1, 0x3dd68c],  // Sigil  → Kprobe  (cert push)
      [0, 2, 0x3dd68c],  // Sigil  → Conduit (cert)
      [0, 3, 0x6fb6ff],  // Sigil  → Trace   (config events)
      [1, 3, 0xf97e6f],  // Kprobe → Trace   (telemetry)
      [2, 3, 0xb898ff],  // Conduit→ Trace   (metrics)
    ];
    // Pod → nearest enforcer edges
    const POD_EDGES = [[4,1],[5,1],[6,1],[7,2],[8,2]];

    COMP_EDGES.forEach(([a, b, col]) => {
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([vecs[a], vecs[b]]),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.28 }),
      ));
    });
    POD_EDGES.forEach(([p, c]) => {
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([vecs[p], vecs[c]]),
        new THREE.LineBasicMaterial({ color: 0x1a3348, transparent: true, opacity: 0.35 }),
      ));
    });

    // Animated pulse particles traveling along each component edge
    const pGeo = new THREE.SphereGeometry(0.042, 8, 8);
    const pulses = COMP_EDGES.map(([a, b, col], i) => {
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0 });
      const mesh = new THREE.Mesh(pGeo, mat);
      group.add(mesh);
      return { mesh, from: vecs[a], to: vecs[b], t: i / COMP_EDGES.length, speed: 0.007 + Math.random() * 0.004 };
    });

    let mouseX = 0, mouseY = 0;
    const onPtr = e => {
      const rc = canvas.getBoundingClientRect();
      mouseX = (e.clientX - rc.left) / rc.width - 0.5;
      mouseY = (e.clientY - rc.top) / rc.height - 0.5;
    };
    window.addEventListener("pointermove", onPtr);

    let autoY = 0, smX = 0, smY = 0;
    const clk = new THREE.Clock();
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const t = clk.getElapsedTime();
      autoY += 0.0022;
      smX += (-mouseY * 0.35 - smX) * 0.055;
      smY += (mouseX * 0.28 - smY) * 0.055;
      group.rotation.y = autoY + smY;
      group.rotation.x = smX;
      starField.rotation.y = autoY * 0.15;
      ring1.rotation.z += 0.005;
      ring2.rotation.z -= 0.003;
      pulses.forEach(p => {
        p.t = (p.t + p.speed) % 1;
        p.mesh.position.lerpVectors(p.from, p.to, p.t);
        p.mesh.material.opacity = Math.sin(p.t * Math.PI) * 0.9;
      });
      meshes.forEach((m, i) => {
        if (i < 4) m.scale.setScalar(1 + Math.sin(t * 1.1 + i * 1.2) * 0.045);
      });
      sigilLight.intensity = 1.8 + Math.sin(t * 0.9) * 0.5;
      renderer.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const nW = canvas.clientWidth, nH = canvas.clientHeight;
      if (!nW || !nH) return;
      camera.aspect = nW / nH;
      camera.updateProjectionMatrix();
      renderer.setSize(nW, nH);
    });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("pointermove", onPtr);
      ro.disconnect();
      group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      renderer.dispose();
      starGeo.dispose();
    };
  }, []);

  return <canvas ref={ref} className="mesh-canvas" />;
}

// ─── Component 3D Icon Canvas ─────────────────────────────────────────────────
// Renders a unique 3D shape per MeshLite component. Mounted once; active shape
// is toggled via a ref so no WebGL context is recreated on tab switches.
function CompCanvas3D({ compName }) {
  const ref = useRef(null);
  const nameRef = useRef(compName);
  useEffect(() => { nameRef.current = compName; }, [compName]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let animId;
    const W = canvas.clientWidth || 100;
    const H = canvas.clientHeight || 100;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 50);
    camera.position.set(0, 0, 4.5);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const ptLight = new THREE.PointLight(0xffffff, 2.8, 16);
    ptLight.position.set(3, 3, 4);
    scene.add(ptLight);

    const group = new THREE.Group();
    scene.add(group);

    const ACCENT = { Sigil: 0x6fb6ff, Kprobe: 0xf97e6f, Conduit: 0xb898ff, Trace: 0x4ade9e };
    const solidMat = col => new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: 0.38, transparent: true, opacity: 0.84 });
    const wireMat  = col => new THREE.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: 0.38 });

    const mkGroup = name => {
      const g = new THREE.Group();
      const col = ACCENT[name];
      if (name === "Sigil") {
        // Octahedron + wireframe  — certificate authority seal
        g.add(new THREE.Mesh(new THREE.OctahedronGeometry(1.15, 0), solidMat(col)));
        g.add(new THREE.Mesh(new THREE.OctahedronGeometry(1.17, 0), wireMat(col)));
      } else if (name === "Kprobe") {
        // Torus + inner ring — eBPF kernel hook
        g.add(new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.22, 14, 52), solidMat(col)));
        g.add(new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.07, 8, 36),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35 })));
      } else if (name === "Conduit") {
        // Two interlocked toruses — mTLS tunnel
        const t1 = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.16, 12, 44), solidMat(col));
        const t2 = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.16, 12, 44),
          new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: 0.32, transparent: true, opacity: 0.70 }));
        t2.rotation.x = Math.PI / 2;
        g.add(t1); g.add(t2);
      } else if (name === "Trace") {
        // Icosahedron + wireframe — observation graph
        g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 1), solidMat(col)));
        g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.17, 1), wireMat(col)));
      }
      return g;
    };

    const NAMES = ["Sigil", "Kprobe", "Conduit", "Trace"];
    const shapeGroups = {};
    NAMES.forEach(n => {
      const sg = mkGroup(n);
      sg.visible = n === nameRef.current;
      group.add(sg);
      shapeGroups[n] = sg;
    });

    let mouseX = 0, mouseY = 0;
    const onPtr = e => {
      const rc = canvas.getBoundingClientRect();
      mouseX = (e.clientX - rc.left) / rc.width - 0.5;
      mouseY = (e.clientY - rc.top) / rc.height - 0.5;
    };
    window.addEventListener("pointermove", onPtr);

    let smX = 0, smY = 0;
    const clk = new THREE.Clock();
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const t = clk.getElapsedTime();
      const active = nameRef.current;
      NAMES.forEach(n => { shapeGroups[n].visible = n === active; });
      smX += (-mouseY * 0.45 - smX) * 0.08;
      smY += (mouseX * 0.45 - smY) * 0.08;
      group.rotation.y = t * 0.55 + smY;
      group.rotation.x = 0.28 + smX;
      if (active === "Kprobe") shapeGroups.Kprobe.children[1].rotation.z -= 0.04;
      if (active === "Conduit") {
        shapeGroups.Conduit.children[0].rotation.z += 0.02;
        shapeGroups.Conduit.children[1].rotation.y += 0.018;
      }
      renderer.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const nW = canvas.clientWidth, nH = canvas.clientHeight;
      if (!nW || !nH) return;
      camera.aspect = nW / nH;
      camera.updateProjectionMatrix();
      renderer.setSize(nW, nH);
    });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("pointermove", onPtr);
      ro.disconnect();
      group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      renderer.dispose();
    };
  }, []);

  return <canvas ref={ref} className="comp-canvas-3d" />;
}

// ─── Topbar ───────────────────────────────────────────────────────────────────
function Topbar({ page, setPage }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <button className="brand" onClick={() => setPage("home")}>
          <span className="brand-dot" />MeshLite
        </button>
        <nav className="topbar-nav">
          <button className={`nav-btn${page === "home" ? " active" : ""}`} onClick={() => setPage("home")}>Product</button>
          <button className={`nav-btn${page === "docs" ? " active" : ""}`} onClick={() => setPage("docs")}>Docs</button>
          <a className="nav-btn" href="https://github.com/andrew-william-dev/Meshlite" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        {page === "home" ? (
          <button className="topbar-cta" onClick={() => setPage("docs")}>Get started →</button>
        ) : (
          <button className="topbar-cta topbar-back" onClick={() => setPage("home")}>← Product</button>
        )}
      </div>
    </header>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────
function Hero({ onDocsClick }) {
  return (
    <section className="hero">
      <div className="hero-glow g1" />
      <div className="hero-glow g2" />
      <div className="hero-grid-bg" />
      <div className="container hero-split">
        <div className="hero-text">
          <div className="hero-eyebrow">Zero Trust · eBPF · Kubernetes</div>
          <h1>
            Service mesh security.<br />
            <span className="em-teal">Without the complexity.</span>
          </h1>
          <p className="hero-sub">
            mTLS identity, policy enforcement, cross-cluster traffic control, and real-time
            observability — without sidecars, heavyweight operators, or a 20-pod control plane.
          </p>
          <div className="hero-btns">
            <button className="btn-primary" onClick={onDocsClick}>Get started</button>
            <a className="btn-outline" href="https://github.com/andrew-william-dev/Meshlite" target="_blank" rel="noreferrer">
              View on GitHub
            </a>
          </div>
          <div className="stat-strip">
            <div className="stat"><span className="stat-num">0</span><span className="stat-lbl">sidecars</span></div>
            <div className="stat-div" />
            <div className="stat"><span className="stat-num">~4</span><span className="stat-lbl">ctrl plane pods</span></div>
            <div className="stat-div" />
            <div className="stat"><span className="stat-num">+7ms</span><span className="stat-lbl">p99 overhead</span></div>
            <div className="stat-div" />
            <div className="stat"><span className="stat-num">1</span><span className="stat-lbl">Helm chart</span></div>
          </div>
        </div>
        <div className="hero-canvas-wrap" aria-hidden="true">
          <TopologyCanvas />
          <div className="canvas-status">
            <span className="cs-dot" />
            <span className="cs-text">4 components · 5 service edges · eBPF enforced</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Comparison section ───────────────────────────────────────────────────────
const CMP_ROWS = [
  { feature: "Sidecars",        ml: { metric: "0",       label: "per pod",      sub: "eBPF at kernel layer — no proxy processes" },     istio: { metric: "1+",      label: "per pod",      sub: "Envoy proxy, 60–100 MB each" } },
  { feature: "Control plane",   ml: { metric: "~4",      label: "pods total",   sub: "Sigil + Kprobe DaemonSet + Conduit + Trace" },     istio: { metric: "10–20",   label: "pods",         sub: "Plus sidecars injected on every workload" } },
  { feature: "Installation",    ml: { metric: "1",       label: "Helm chart",   sub: "One namespace. No CRD bundle. No operator." },      istio: { metric: "3+",      label: "steps",        sub: "CRD bundle, Operator, sidecar injector" } },
  { feature: "Observability",   ml: { metric: "0",       label: "extra tools",  sub: "Trace ships built-in with the platform" },           istio: { metric: "3",       label: "extra tools",  sub: "Kiali + Prometheus + Grafana all required" } },
  { feature: "Cross-cluster",   ml: { metric: "2",       label: "YAML stanzas", sub: "One for Egress cluster, one for Ingress" },           istio: { metric: "complex", label: "federation",   sub: "Multi-cluster mesh config + CA federation" } },
  { feature: "Memory overhead", ml: { metric: "≈0",      label: "per workload", sub: "eBPF: one kernel program per node" },                 istio: { metric: "60MB+",   label: "per pod",      sub: "Envoy sidecar on every workload" } },
];

function ComparisonSection() {
  const [hov, setHov] = useState(null);
  return (
    <section className="page-section">
      <div className="container">
        <div className="sec-head">
          <span className="eyebrow">Why MeshLite</span>
          <h2>A real alternative to Istio</h2>
          <p className="sec-desc">
            Istio is powerful but built for massive platforms. MeshLite delivers the same
            zero-trust guarantees at a fraction of the operational complexity.
          </p>
        </div>
        <div className="cmp-arena">
          <div className="cmp-header-row">
            <div className="cmp-feat-col" />
            <div className="cmp-col-hd ml-hd"><span className="brand-dot" />MeshLite</div>
            <div className="cmp-col-hd is-hd">Istio</div>
          </div>
          {CMP_ROWS.map((row, i) => (
            <div
              key={row.feature}
              className={`cmp-row${hov === i ? " cmp-row-on" : ""}`}
              onMouseEnter={() => setHov(i)}
              onMouseLeave={() => setHov(null)}
            >
              <div className="cmp-feat">{row.feature}</div>
              <div className="cmp-cell ml-cell">
                <div className="cmp-metric-wrap">
                  <span className="cmp-num ml-num">{row.ml.metric}</span>
                  <span className="cmp-unit">{row.ml.label}</span>
                </div>
                <span className="cmp-sub">{row.ml.sub}</span>
              </div>
              <div className="cmp-cell is-cell">
                <div className="cmp-metric-wrap">
                  <span className="cmp-num is-num">{row.istio.metric}</span>
                  <span className="cmp-unit">{row.istio.label}</span>
                </div>
                <span className="cmp-sub">{row.istio.sub}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Components explorer ──────────────────────────────────────────────────────
const COMPS = [
  {
    name: "Sigil", tag: "Control Plane", accent: "#6fb6ff", icon: "⬡",
    summary: "The single certificate authority and policy engine for the entire mesh.",
    detail: "Sigil issues ECDSA P-256 certificates to every registered service, owns the policy store, and pushes updates to Kprobe agents in real time. All certificates across all clusters derive from one root — simplifying cross-cluster identity without a separate federation setup.",
    bullets: ["ECDSA P-256 cert issuance", "Push-based policy distribution", "Online rotation without restarts", "Single root CA for all clusters"],
  },
  {
    name: "Kprobe", tag: "eBPF Enforcer", accent: "#f97e6f", icon: "◈",
    summary: "Kubernetes traffic enforcement at the kernel layer. No sidecar per pod.",
    detail: "A Rust eBPF program attached to the tc hook on each node. It intercepts pod-to-pod traffic, resolves identities, and decides ALLOW or DENY before the packet reaches the application — at kernel speed, with no proxy process running beside your workloads.",
    bullets: ["No sidecar, no extra process per pod", "tc layer interception via Rust + Aya", "Sub-millisecond policy decisions", "Telemetry with no overhead"],
  },
  {
    name: "Conduit", tag: "Cross-Cluster Gateway", accent: "#c4a6ff", icon: "⇄",
    summary: "mTLS enforcement at the cluster boundary where eBPF cannot reach.",
    detail: "Egress wraps outbound traffic in mTLS with Sigil-issued identity. Ingress verifies that identity before forwarding to internal workloads. Configure a full cross-cluster boundary with just two YAML stanzas in your Helm values.",
    bullets: ["Mutual TLS at the cluster edge", "Sigil-backed identity on both sides", "Single YAML stanza per cluster role", "Supports any multi-cluster topology"],
  },
  {
    name: "Trace", tag: "Observability", accent: "#4ade9e", icon: "◉",
    summary: "Real-time service topology, event feed, and latency — in one container.",
    detail: "Accumulates telemetry from Kprobe and Conduit. Renders a live service graph, per-edge latency, ALLOW / DENY event feed, and cross-cluster edge classification. Single container. No Prometheus. No Kiali CRDs. No Grafana dashboards to import.",
    bullets: ["Live service topology map", "Policy event feed with timestamps", "p50 / p99 per edge", "Cross-cluster edges tagged distinctly"],
  },
];

function ComponentsExplorer() {
  const [active, setActive] = useState("Sigil");
  const comp = COMPS.find((c) => c.name === active);
  return (
    <section className="page-section section-alt">
      <div className="container">
        <div className="sec-head">
          <span className="eyebrow">Architecture</span>
          <h2>Four components, one coherent platform</h2>
          <p className="sec-desc">
            Each has a single responsibility. Together they form a runtime security layer
            completely transparent to application workloads.
          </p>
        </div>
        <div className="comp-explorer">
          <div className="comp-tabs">
            {COMPS.map((c) => (
              <button
                key={c.name}
                className={`comp-tab${active === c.name ? " active" : ""}`}
                style={{ "--ca": c.accent }}
                onClick={() => setActive(c.name)}
              >
                <span className="tab-icon">{c.icon}</span>
                <div className="tab-info">
                  <span className="tab-name">{c.name}</span>
                  <span className="tab-sub">{c.tag}</span>
                </div>
              </button>
            ))}
          </div>
          <div className="comp-panel" style={{ "--ca": comp.accent }}>
            <div className="panel-top">
              <div className="panel-canvas-wrap">
                <CompCanvas3D compName={active} />
              </div>
              <div>
                <span className="panel-tag" style={{ color: comp.accent }}>{comp.tag}</span>
                <h3 className="panel-name">{comp.name}</h3>
              </div>
            </div>
            <p className="panel-summary">{comp.summary}</p>
            <p className="panel-detail">{comp.detail}</p>
            <ul className="panel-bullets">
              {comp.bullets.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Trace spotlight ──────────────────────────────────────────────────────────
function TraceSection() {
  const feats = [
    { icon: "◎", h: "Live service graph", p: "Auto-discovered from eBPF telemetry. Edges show ALLOW / DENY and cross-cluster classification, updated in real time." },
    { icon: "≡", h: "Policy event feed", p: "Every ALLOW and DENY decision in a live stream with service identity, direction, and timestamp. Incident triage in seconds." },
    { icon: "⊞", h: "Cross-cluster awareness", p: "Conduit-forwarded requests are tagged with their origin cluster and shown distinctly in the topology graph." },
    { icon: "∿", h: "Latency distribution", p: "p50 and p99 per edge, continuously measured. Baseline validated at +7.151ms p99 cross-cluster overhead." },
    { icon: "▣", h: "Denial feed", p: "Filter denied requests by service or time window. Critical for security audits and compliance reporting." },
    { icon: "✦", h: "No external stack", p: "One container. No Prometheus config. No Kiali CRDs. No Grafana dashboards to import. It works out of the box." },
  ];
  return (
    <section className="page-section trace-bg">
      <div className="container">
        <div className="trace-layout">
          <div className="trace-left">
            <span className="eyebrow eyebrow-green">Trace</span>
            <h2>Observability that comes for free</h2>
            <p className="sec-desc" style={{ marginBottom: "1.8rem" }}>
              Other meshes require an entire monitoring stack — Prometheus, Kiali, Grafana —
              just to see what is happening. MeshLite ships Trace as part of the platform.
              Your service topology, policy events, and latency numbers are live the moment
              you install.
            </p>
            <div className="trace-proofs">
              <div className="trace-proof">
                <strong>8 services / 10 edges</strong>
                <span>verified live in Phase 5</span>
              </div>
              <div className="trace-proof">
                <strong>ALLOW + DENY</strong>
                <span>validated via meshctl verify</span>
              </div>
            </div>
          </div>
          <div className="trace-feats">
            {feats.map((f) => (
              <div className="trace-feat" key={f.h}>
                <span className="tf-icon">{f.icon}</span>
                <div>
                  <h4>{f.h}</h4>
                  <p>{f.p}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Get started section ──────────────────────────────────────────────────────
function GetStartedSection({ onDocsClick }) {
  const { loading, data } = useLatestRelease();
  const tag = data?.tag_name || "v0.5.5";
  const winAsset = useMemo(
    () => data?.assets?.find((a) => a.name.toLowerCase().includes("meshctl") && a.name.toLowerCase().includes("windows")),
    [data]
  );
  return (
    <section className="page-section section-alt">
      <div className="container">
        <div className="gs-layout">
          <div className="gs-copy">
            <span className="eyebrow">Get started</span>
            <h2>Up in three commands</h2>
            <p className="sec-desc" style={{ marginBottom: "1.8rem" }}>
              No sidecar injection. No CRD bundles. No 20-pod control plane to manage.
              One Helm chart gets you the full platform.
            </p>
            <div className="gs-btns">
              <button className="btn-primary" onClick={onDocsClick}>Read the docs</button>
              <a className="btn-outline" href="https://github.com/andrew-william-dev/Meshlite" target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            </div>
            {!loading && data && (
              <div className="release-badge">
                <span className="rb-dot" />
                <span>Latest: <strong>{tag}</strong></span>
                {winAsset && (
                  <a href={winAsset.browser_download_url} target="_blank" rel="noreferrer">Windows ↓</a>
                )}
              </div>
            )}
          </div>
          <div className="terminal">
            <div className="term-bar">
              <span className="tdot tdot-r" /><span className="tdot tdot-y" /><span className="tdot tdot-g" />
              <span className="term-title">bash</span>
            </div>
            <pre className="term-body"><code>{`# 1. Install the platform
helm upgrade --install meshlite ./charts/meshlite \\
  --namespace meshlite-system --create-namespace

# 2. Install meshctl — single binary, no Go required
curl -sSfL https://github.com/andrew-william-dev/\\
  Meshlite/releases/download/${tag}/meshctl_${tag}_linux_amd64.tar.gz \\
  | tar -xz -C /usr/local/bin

# 3. Verify
meshctl status
meshctl verify --from service-a --to service-b`}</code></pre>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Home ─────────────────────────────────────────────────────────────────────
function HomePage({ onDocsClick }) {
  return (
    <main className="home">
      <Hero onDocsClick={onDocsClick} />
      <ComparisonSection />
      <ComponentsExplorer />
      <TraceSection />
      <GetStartedSection onDocsClick={onDocsClick} />
    </main>
  );
}

// ─── Docs nav map ─────────────────────────────────────────────────────────────
const DOC_NAV = [
  {
    group: "Get started",
    items: [
      { id: "overview",        label: "Introduction",    icon: "◎" },
      { id: "quickstart-same", label: "Same-cluster",     icon: "\u2192", sub: "5 min" },
      { id: "quickstart-cross",label: "Cross-cluster",    icon: "\u2197", sub: "15 min" },
    ],
  },
  {
    group: "Installation",
    items: [
      { id: "helm-install",    label: "Helm install",     icon: "\u229e" },
      { id: "helm-values",     label: "Values reference", icon: "\u2261" },
      { id: "meshctl-install", label: "Install meshctl",  icon: "\u2318" },
    ],
  },
  {
    group: "Components",
    items: [
      { id: "sigil",   label: "Sigil",   icon: "\u2b21", sub: "Control plane" },
      { id: "kprobe",  label: "Kprobe",  icon: "\u25c8", sub: "eBPF enforcer" },
      { id: "conduit", label: "Conduit", icon: "\u21c4", sub: "Cross-cluster" },
      { id: "trace",   label: "Trace",   icon: "\u25c9", sub: "Observability" },
    ],
  },
  {
    group: "Operations",
    items: [
      { id: "policy",       label: "Policy model",     icon: "\u2713" },
      { id: "multicluster", label: "Multi-cluster",    icon: "\u229e" },
      { id: "meshctl-ref",  label: "meshctl reference",icon: "\u2318" },
      { id: "architecture", label: "Architecture",     icon: "\u25b1" },
    ],
  },
];

// ─── Doc: Overview ────────────────────────────────────────────────────────────
function DocOverview() {
  const navigate = useContext(DocNavContext);
  const paths = [
    { icon: "→", title: "Same-cluster quickstart",  desc: "mTLS identity, policy enforcement, and live observability in one cluster.", tag: "5 min",    id: "quickstart-same",  accent: "#3dd68c" },
    { icon: "↗", title: "Cross-cluster quickstart", desc: "Connect two clusters with Sigil-backed mTLS and Conduit boundary enforcement.", tag: "15 min", id: "quickstart-cross", accent: "#6fb6ff" },
    { icon: "◱", title: "Explore the architecture", desc: "How Sigil, Kprobe, Conduit, and Trace compose into one zero-trust platform.", tag: "Concepts", id: "architecture",     accent: "#b898ff" },
  ];
  return (
    <article className="doc-page">
      <div className="doc-welcome">
        <h1>MeshLite Documentation</h1>
        <p className="doc-lead">
          Zero-trust networking for Kubernetes. mTLS service identity, policy enforcement,
          cross-cluster traffic control, and real-time observability — without sidecars,
          heavyweight operators, or a 20-pod control plane.
        </p>
      </div>
      <p className="doc-pick-heading">Where do you want to start?</p>
      <div className="doc-path-cards">
        {paths.map((p) => (
          <button key={p.id} className="doc-path-card" style={{ "--pca": p.accent }}
            onClick={() => { navigate(p.id); window.scrollTo(0, 0); }}>
            <span className="dpc-icon">{p.icon}</span>
            <span className="dpc-tag">{p.tag}</span>
            <strong className="dpc-title">{p.title}</strong>
            <span className="dpc-desc">{p.desc}</span>
            <span className="dpc-arrow">→</span>
          </button>
        ))}
      </div>
      <h2>What MeshLite gives you</h2>
      <ul>
        <li><strong>Service identity</strong> — Sigil-issued ECDSA P-256 certificates for every workload, rotated continuously without restarts.</li>
        <li><strong>Policy enforcement</strong> — ALLOW / DENY rules evaluated per-request at the kernel layer, declared in a single <code>mesh.yaml</code>. No match defaults to <strong>DENY</strong>.</li>
        <li><strong>Cross-cluster protection</strong> — Conduit enforces mTLS at the cluster boundary with Sigil-backed identity on both sides. Two Helm stanzas to configure.</li>
        <li><strong>Real-time observability</strong> — Trace renders live topology, event feeds, and latency. No Prometheus, Kiali, or Grafana required.</li>
        <li><strong>CLI operations</strong> — meshctl covers apply, status, verify, logs, and rotate. One binary, no Go required.</li>
      </ul>
      <h2>How it compares to Istio</h2>
      <table className="doc-table">
        <thead><tr><th>Dimension</th><th>MeshLite</th><th>Istio</th></tr></thead>
        <tbody>
          <tr><td>Sidecar per pod</td><td>No — eBPF at kernel layer</td><td>Yes — Envoy proxy (60–100 MB each)</td></tr>
          <tr><td>Control plane pods</td><td>~4</td><td>10–20 + sidecars on every workload</td></tr>
          <tr><td>Installation</td><td>1 Helm chart, no CRD bundle</td><td>CRD bundle + Operator + injector webhook</td></tr>
          <tr><td>Observability</td><td>Trace built-in, zero extra tools</td><td>Kiali + Prometheus + Grafana required</td></tr>
          <tr><td>Cross-cluster</td><td>Two Helm values stanzas</td><td>Multi-cluster config + CA federation</td></tr>
          <tr><td>Memory per workload</td><td>≈0 MB (one eBPF program per node)</td><td>60 MB+ Envoy sidecar per pod</td></tr>
        </tbody>
      </table>
      <NextSteps items={[
        { id: "quickstart-same",  title: "Single-cluster quickstart", desc: "Install and write your first policy." },
        { id: "quickstart-cross", title: "Cross-cluster quickstart",  desc: "Connect two clusters with mTLS." },
        { id: "architecture",     title: "Architecture",             desc: "How all four components fit together." },
        { id: "helm-install",     title: "Helm install",             desc: "Full prerequisites and install options." },
      ]} />
    </article>
  );
}

// ─── Doc: Same-cluster quickstart ────────────────────────────────────────────
function QuickstartSame() {
  return (
    <article className="doc-page">
      <span className="doc-section-badge same-cluster">✓ Same-cluster</span>
      <div className="doc-time-badge">⏱ <span>~5 minutes</span></div>
      <h1>Single-cluster quickstart</h1>
      <p className="doc-lead">
        Get mTLS service identity, declarative policy enforcement, and live observability
        in one Kubernetes cluster — in about five minutes.
      </p>
      <DocPrereqs items={["Kubernetes 1.26+", "Helm 3.10+", "kubectl", "Cluster-admin access"]} />
      <h2>Install MeshLite</h2>
      <div className="doc-steps">
        <DocStep num="1" title="Install the umbrella chart">
          <pre className="codeblock"><code>{`helm upgrade --install meshlite ./charts/meshlite \\
  --namespace meshlite-system \\
  --create-namespace`}</code></pre>
          <p>All four components — Sigil, Kprobe, Conduit, Trace — deploy in one namespace.</p>
        </DocStep>
        <DocStep num="2" title="Wait for pods to be ready">
          <pre className="codeblock"><code>{`kubectl get pods -n meshlite-system --watch
# All pods reach Running within ~60 s`}</code></pre>
        </DocStep>
        <DocStep num="3" title="Install meshctl">
          <pre className="codeblock"><code>{`VERSION=v1.0.0
curl -sSfL \\
  "https://github.com/andrew-william-dev/Meshlite/releases/download/$VERSION/meshctl_${"{VERSION}"}_linux_amd64.tar.gz" \\
  | tar -xz -C /usr/local/bin`}</code></pre>
        </DocStep>
        <DocStep num="4" title="Verify the platform is healthy">
          <pre className="codeblock"><code>{`meshctl status --sigil-url http://sigil.meshlite-system:8080`}</code></pre>
          <p>You should see all Kprobe agents and their connected node counts.</p>
        </DocStep>
      </div>
      <h2>Write your first policy</h2>
      <p>Create a <code>mesh.yaml</code> describing which service-to-service calls are allowed:</p>
      <pre className="codeblock"><code>{`policies:
  - from: service-frontend
    to:   service-api
    action: ALLOW

  - from: "*"
    to:   service-api
    action: DENY`}</code></pre>
      <div className="doc-steps">
        <DocStep num="5" title="Apply the policy">
          <pre className="codeblock"><code>{`meshctl apply -f mesh.yaml \\
  --sigil-url http://sigil.meshlite-system:8080`}</code></pre>
          <p>Policy is pushed to all Kprobe agents within seconds.</p>
        </DocStep>
        <DocStep num="6" title="Predict outcomes before you deploy">
          <pre className="codeblock"><code>{`meshctl verify --from service-frontend --to service-api \\
  --sigil-url http://sigil.meshlite-system:8080
# → ALLOW

meshctl verify --from unknown-svc --to service-api \\
  --sigil-url http://sigil.meshlite-system:8080
# → DENY`}</code></pre>
        </DocStep>
      </div>
      <Callout type="tip">
        <p>Policy is enforced in the kernel by Kprobe — before the packet reaches your application process. No userspace round-trip, no proxy overhead, no added latency on the data path.</p>
      </Callout>
      <h2>Open Trace</h2>
      <div className="doc-steps">
        <DocStep num="7" title="Port-forward the Trace dashboard">
          <pre className="codeblock"><code>{`kubectl port-forward -n meshlite-system svc/trace 3000:3000`}</code></pre>
          <p>Navigate to <code>http://localhost:3000</code>. Once traffic flows between your services, the topology graph, event feed, and latency metrics populate automatically.</p>
        </DocStep>
      </div>
      <Callout type="note">
        <p>No Prometheus config. No Kiali CRDs. No Grafana dashboards to import. Trace works immediately after install.</p>
      </Callout>
      <NextSteps items={[
        { id: "policy",           title: "Policy model",             desc: "Evaluation order, wildcards, deny-by-default." },
        { id: "trace",            title: "Trace reference",          desc: "Topology graph, event feed, and latency views." },
        { id: "quickstart-cross", title: "Cross-cluster quickstart", desc: "Connect two clusters with mTLS boundary enforcement." },
        { id: "helm-values",      title: "Helm values reference",    desc: "All available configuration keys." },
      ]} />
    </article>
  );
}

// ─── Doc: Cross-cluster quickstart ───────────────────────────────────────────
function QuickstartCross() {
  return (
    <article className="doc-page">
      <span className="doc-section-badge cross-cluster">↗ Cross-cluster</span>
      <div className="doc-time-badge">⏱ <span>~15 minutes</span></div>
      <h1>Cross-cluster quickstart</h1>
      <p className="doc-lead">
        Connect two Kubernetes clusters with Sigil-issued mTLS identity, Conduit boundary
        enforcement, and unified observability in Trace — from two Helm values files.
      </p>
      <DocPrereqs items={["Two Kubernetes clusters (1.26+)", "Network reachability between them (port 9000)", "Helm 3.10+", "kubectl access to both clusters"]} />
      <Callout type="note">
        <p><strong>One Sigil instance serves both clusters.</strong> Cluster A hosts the root CA. Both clusters trust the same authority — no separate CA federation required.</p>
      </Callout>
      <h2>Cluster A — primary (Sigil + Egress)</h2>
      <p>Cluster A runs Sigil (the shared root CA), Kprobe, and Conduit Egress for outbound cross-cluster traffic.</p>
      <pre className="codeblock"><code>{`# cluster-a-values.yaml
sigil:
  enabled: true

kprobe:
  cluster:
    id: "cluster-a"
  sigil:
    address: "sigil.meshlite-system:8080"
  trace:
    address: "trace.meshlite-system:3000"

conduitEgress:
  enabled: true
  peer:
    address: "CLUSTER_B_IP:9000"   # NodePort or LoadBalancer IP of Cluster B`}</code></pre>
      <div className="doc-steps">
        <DocStep num="1" title="Install on Cluster A">
          <pre className="codeblock"><code>{`kubectl config use-context <cluster-a-context>

helm upgrade --install meshlite ./charts/meshlite \\
  --namespace meshlite-system --create-namespace \\
  -f cluster-a-values.yaml`}</code></pre>
        </DocStep>
        <DocStep num="2" title="Note Sigil's address for Cluster B">
          <pre className="codeblock"><code>{`kubectl get svc sigil -n meshlite-system
# Note the ClusterIP or LoadBalancer IP — needed in step 3`}</code></pre>
        </DocStep>
      </div>
      <h2>Cluster B — remote (Ingress only)</h2>
      <p>Cluster B runs Kprobe and Conduit Ingress. Sigil is disabled — it points at Cluster A's instance.</p>
      <pre className="codeblock"><code>{`# cluster-b-values.yaml
sigil:
  enabled: false                     # Sigil lives in Cluster A

kprobe:
  cluster:
    id: "cluster-b"
  sigil:
    address: "CLUSTER_A_SIGIL_IP:8080"
  trace:
    address: "CLUSTER_A_TRACE_IP:3000"

conduitIngress:
  enabled: true
  clusterIdentity: "cluster-b"`}</code></pre>
      <div className="doc-steps">
        <DocStep num="3" title="Install on Cluster B">
          <pre className="codeblock"><code>{`kubectl config use-context <cluster-b-context>

helm upgrade --install meshlite ./charts/meshlite \\
  --namespace meshlite-system --create-namespace \\
  -f cluster-b-values.yaml`}</code></pre>
        </DocStep>
        <DocStep num="4" title="Verify both agents appear in Sigil">
          <pre className="codeblock"><code>{`kubectl config use-context <cluster-a-context>

meshctl status --sigil-url http://sigil.meshlite-system:8080
# Agents from cluster-a and cluster-b should both appear`}</code></pre>
        </DocStep>
        <DocStep num="5" title="Apply cross-cluster policy">
          <pre className="codeblock"><code>{`# mesh.yaml
policies:
  - from: service-a    # running in cluster-a
    to:   service-b    # running in cluster-b
    action: ALLOW

meshctl apply -f mesh.yaml \\
  --sigil-url http://sigil.meshlite-system:8080`}</code></pre>
        </DocStep>
        <DocStep num="6" title="Verify and view in Trace">
          <pre className="codeblock"><code>{`meshctl verify --from service-a --to service-b \\
  --sigil-url http://sigil.meshlite-system:8080
# → ALLOW

# Open Trace — cross-cluster edges appear in the "Cross-cluster" view
kubectl port-forward -n meshlite-system svc/trace 3000:3000`}</code></pre>
        </DocStep>
      </div>
      <Callout type="tip">
        <p>In Trace, switch to the <strong>Cross-cluster</strong> view to isolate traffic that traverses cluster boundaries. Each edge shows the origin cluster ID, latency, and request count.</p>
      </Callout>
      <h2>Networking requirements</h2>
      <p>Conduit Egress in Cluster A must reach Conduit Ingress in Cluster B on port 9000. Supported methods:</p>
      <ul>
        <li>NodePort service exposed on Cluster B's nodes</li>
        <li>LoadBalancer service with a routable external IP on Cluster B</li>
        <li>VPN or VPC peering between the node networks of both clusters</li>
      </ul>
      <Callout type="warning">
        <p>Both clusters need network-level reachability on port 9000. Check firewall rules, security groups, and Kubernetes NetworkPolicy if connectivity tests fail.</p>
      </Callout>
      <NextSteps items={[
        { id: "multicluster", title: "Multi-cluster reference", desc: "Full topology options and advanced config." },
        { id: "conduit",      title: "Conduit deep-dive",       desc: "Egress/ingress modes and identity model." },
        { id: "trace",        title: "Trace reference",         desc: "How cross-cluster edges are tagged." },
        { id: "policy",       title: "Policy model",            desc: "Cross-cluster policy evaluation." },
      ]} />
    </article>
  );
}


// ─── Doc: Architecture ────────────────────────────────────────────────────────
function DocArchitecture() {
  return (
    <article className="doc-page">
      <h1>Architecture</h1>
      <p className="doc-lead">MeshLite is four runtime components, each with a single responsibility, composing into a complete zero-trust networking layer that is fully transparent to application workloads.</p>
      <h2>Component overview</h2>
      <table className="doc-table">
        <thead><tr><th>Component</th><th>Role</th><th>Technology</th></tr></thead>
        <tbody>
          <tr><td><strong>Sigil</strong></td><td>Control plane, certificate authority, policy store</td><td>Go</td></tr>
          <tr><td><strong>Kprobe</strong></td><td>Same-cluster eBPF enforcer and telemetry emitter</td><td>Rust + Aya</td></tr>
          <tr><td><strong>Conduit</strong></td><td>Cross-cluster egress / ingress gateway</td><td>Go</td></tr>
          <tr><td><strong>Trace</strong></td><td>Observability backend and operator dashboard</td><td>Go + React</td></tr>
        </tbody>
      </table>
      <h2>Same-cluster request flow</h2>
      <ol>
        <li>Service A sends a plain HTTP request to Service B.</li>
        <li>Kprobe intercepts it at the kernel <code>tc</code> layer.</li>
        <li>Kprobe resolves source and destination identity from IP/port maps.</li>
        <li>Kprobe checks live policy from Sigil — ALLOW continues; DENY is dropped in the kernel.</li>
        <li>A telemetry record is emitted to Trace.</li>
      </ol>
      <h2>Cross-cluster request flow</h2>
      <ol>
        <li>Kprobe detects the destination is outside the local cluster.</li>
        <li>Traffic is routed to <strong>Conduit Egress</strong> at the cluster edge.</li>
        <li>Conduit Egress applies Sigil-issued mTLS and boundary policy.</li>
        <li>Traffic transits the network (VPN, VPC peering, NodePort).</li>
        <li><strong>Conduit Ingress</strong> in the destination verifies identity and forwards the request.</li>
        <li>Trace receives cross-cluster telemetry tagged with the origin cluster ID.</li>
      </ol>
      <h2>Design principles</h2>
      <ul>
        <li><strong>Zero application change</strong> — services use plain HTTP; MeshLite handles the rest beneath them.</li>
        <li><strong>Kernel-first intra-cluster</strong> — eBPF <code>tc</code> hooks, one program per node, not one proxy per pod.</li>
        <li><strong>Gateway-first cross-cluster</strong> — Conduit handles the boundary where eBPF cannot reach.</li>
        <li><strong>Single root CA</strong> — Sigil is the only authority; all certs across all clusters derive from here.</li>
        <li><strong>Observability as a byproduct</strong> — Kprobe sees every packet; Trace collects it with no added overhead.</li>
      </ul>
    </article>
  );
}

// ─── Doc: Helm Install ────────────────────────────────────────────────────────
function DocHelmInstall() {
  return (
    <article className="doc-page">
      <h1>Helm Installation</h1>
      <p className="doc-lead">MeshLite ships as an umbrella Helm chart. Kubernetes 1.26+ and Helm 3.10+ are the only prerequisites.</p>
      <h2>Prerequisites</h2>
      <ul>
        <li>Kubernetes 1.26 or later</li>
        <li>Helm 3.10 or later — confirm with <code>helm version</code></li>
        <li>Cluster admin permissions (Kprobe needs <code>CAP_BPF</code> and <code>CAP_NET_ADMIN</code>)</li>
      </ul>
      <h2>Install</h2>
      <pre className="codeblock"><code>{`helm upgrade --install meshlite ./charts/meshlite \\
  --namespace meshlite-system \\
  --create-namespace`}</code></pre>
      <h2>Verify</h2>
      <pre className="codeblock"><code>{`kubectl get pods -n meshlite-system
# All pods should reach Running within ~60s

meshctl status --sigil-url http://sigil.meshlite-system:8080`}</code></pre>
      <h2>Custom values</h2>
      <pre className="codeblock"><code>{`helm upgrade --install meshlite ./charts/meshlite \\
  --namespace meshlite-system \\
  --create-namespace \\
  -f ./my-values.yaml`}</code></pre>
      <p>See <strong>Helm Values Reference</strong> for all available keys.</p>
      <h2>Uninstall</h2>
      <pre className="codeblock"><code>{`helm uninstall meshlite -n meshlite-system
kubectl delete namespace meshlite-system`}</code></pre>
    </article>
  );
}

// ─── Doc: Helm Values ─────────────────────────────────────────────────────────
function DocHelmValues() {
  return (
    <article className="doc-page">
      <h1>Helm Values Reference</h1>
      <p className="doc-lead">All component configuration is controlled through <code>charts/meshlite/values.yaml</code>. Override keys with <code>--set</code> or a custom <code>-f</code> file.</p>
      <h2>Global</h2>
      <table className="doc-table">
        <thead><tr><th>Key</th><th>Default</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>global.imageTag</code></td><td><code>""</code></td><td>Shared image tag override for all components</td></tr>
          <tr><td><code>global.imagePullPolicy</code></td><td><code>IfNotPresent</code></td><td>Image pull policy applied to all pods</td></tr>
        </tbody>
      </table>
      <h2>Sigil</h2>
      <table className="doc-table">
        <thead><tr><th>Key</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>sigil.enabled</code></td><td>Enable or disable the Sigil control plane</td></tr>
          <tr><td><code>sigil.config.port</code></td><td>gRPC port Sigil listens on (default: 8080)</td></tr>
          <tr><td><code>sigil.config.ca.certTTLHours</code></td><td>Certificate TTL in hours before rotation triggers</td></tr>
        </tbody>
      </table>
      <h2>Kprobe</h2>
      <table className="doc-table">
        <thead><tr><th>Key</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>kprobe.cluster.id</code></td><td>Unique string ID for this cluster (used in Trace cross-cluster tagging)</td></tr>
          <tr><td><code>kprobe.sigil.address</code></td><td>Sigil address for policy and cert sync</td></tr>
          <tr><td><code>kprobe.trace.address</code></td><td>Trace backend ingestion address</td></tr>
        </tbody>
      </table>
      <h2>Conduit</h2>
      <table className="doc-table">
        <thead><tr><th>Key</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>conduitEgress.enabled</code></td><td>Enable egress gateway for outbound cross-cluster traffic</td></tr>
          <tr><td><code>conduitEgress.peer.address</code></td><td>Address of Conduit Ingress in the destination cluster</td></tr>
          <tr><td><code>conduitIngress.enabled</code></td><td>Enable ingress gateway for inbound cross-cluster traffic</td></tr>
          <tr><td><code>conduitIngress.clusterIdentity</code></td><td>Identity label sent to Sigil for cross-cluster verification</td></tr>
        </tbody>
      </table>
      <h2>Trace</h2>
      <table className="doc-table">
        <thead><tr><th>Key</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>trace.enabled</code></td><td>Enable or disable Trace</td></tr>
          <tr><td><code>trace.ingress.enabled</code></td><td>Expose Trace UI via a Kubernetes Ingress</td></tr>
          <tr><td><code>trace.ingress.host</code></td><td>Hostname for the Trace ingress rule</td></tr>
        </tbody>
      </table>
    </article>
  );
}

// ─── Doc: meshctl Install ─────────────────────────────────────────────────────
function DocMeshctlInstall() {
  return (
    <article className="doc-page">
      <h1>Install meshctl</h1>
      <p className="doc-lead">meshctl is a precompiled binary for Linux, macOS, and Windows. No Go installation required. Download once, place on your PATH, run anywhere.</p>
      <h2>Linux / macOS</h2>
      <pre className="codeblock"><code>{`VERSION=v0.5.5
OS=linux      # or: darwin
ARCH=amd64    # or: arm64

curl -sSfL \\
  "https://github.com/andrew-william-dev/Meshlite/releases/download/$VERSION/meshctl_${"{VERSION}"}_${"{OS}"}_${"{ARCH}"}.tar.gz" \\
  | tar -xz -C /usr/local/bin

chmod +x /usr/local/bin/meshctl
meshctl version`}</code></pre>
      <h2>Windows (PowerShell)</h2>
      <pre className="codeblock"><code>{`$v = "v0.5.5"
$url = "https://github.com/andrew-william-dev/Meshlite/releases/download/$v/meshctl_" + $v + "_windows_amd64.zip"
Invoke-WebRequest -Uri $url -OutFile meshctl.zip
Expand-Archive meshctl.zip "$env:LOCALAPPDATA\\meshctl"
$env:PATH += ";$env:LOCALAPPDATA\\meshctl"
meshctl version`}</code></pre>
      <h2>Verify</h2>
      <pre className="codeblock"><code>{`meshctl version
# meshctl v0.5.5 (linux/amd64)`}</code></pre>
    </article>
  );
}

// ─── Doc: Sigil ───────────────────────────────────────────────────────────────
function DocSigil() {
  return (
    <article className="doc-page">
      <h1>Sigil — Control Plane</h1>
      <p className="doc-lead">Sigil is the control center of MeshLite. Certificate authority, policy store, and distribution hub — all in one component.</p>
      <h2>Responsibilities</h2>
      <ul>
        <li>Issue ECDSA P-256 certificates to every registered service identity</li>
        <li>Store and evaluate ALLOW / DENY rules loaded from <code>mesh.yaml</code></li>
        <li>Push certificate and policy updates to Kprobe agents on change via gRPC</li>
        <li>Handle rotation requests without requiring workload restarts</li>
        <li>Serve the <code>meshctl verify</code> prediction endpoint</li>
      </ul>
      <h2>Certificate model</h2>
      <p>Sigil is the single root CA. All service certificates across all clusters are signed here. This shared root makes cross-cluster identity verification work without a separate CA federation — both clusters trust the same authority, so Conduit verifies identity directly.</p>
      <h2>Policy format</h2>
      <pre className="codeblock"><code>{`policies:
  - from: service-frontend
    to: service-api
    action: ALLOW
  - from: service-api
    to: service-payments
    action: ALLOW
  - from: "*"
    to: service-internal
    action: DENY`}</code></pre>
      <h2>Common operations</h2>
      <pre className="codeblock"><code>{`meshctl apply -f mesh.yaml --sigil-url http://sigil.meshlite-system:8080
meshctl status --sigil-url http://sigil.meshlite-system:8080
meshctl rotate --service service-api --sigil-url http://sigil.meshlite-system:8080`}</code></pre>
    </article>
  );
}

// ─── Doc: Kprobe ─────────────────────────────────────────────────────────────
function DocKprobe() {
  return (
    <article className="doc-page">
      <h1>Kprobe — eBPF Enforcer</h1>
      <p className="doc-lead">A Rust eBPF program at the kernel <code>tc</code> layer. Intercepts traffic, enforces policy in the kernel, emits telemetry. No sidecar. No extra process per pod.</p>
      <h2>Why eBPF instead of sidecars?</h2>
      <p>Envoy sidecars add 60–100 MB per pod, inject latency on every request, and require a complex injection lifecycle. Kprobe runs one program per node at the kernel level. The policy decision happens before the packet reaches the application process — no context switch, no userspace round-trip.</p>
      <h2>Request lifecycle</h2>
      <ol>
        <li>Kprobe registers with Sigil at startup, receiving a certificate and policy snapshot.</li>
        <li>An eBPF program attaches to the <code>tc</code> hook on each pod network interface.</li>
        <li>Per-packet: source and destination identities are resolved from eBPF maps.</li>
        <li>Policy decision is made in kernel space — ALLOW proceeds, DENY drops the connection.</li>
        <li>Telemetry is placed into a ring buffer and forwarded by the userspace daemon to Trace.</li>
      </ol>
      <h2>Deployment</h2>
      <p>Kprobe runs as a <strong>DaemonSet</strong> — one pod per node. The Helm chart configures the required privileges (<code>CAP_BPF</code>, <code>CAP_NET_ADMIN</code>) automatically.</p>
      <h2>Measured overhead</h2>
      <p>Phase 4 benchmark: <strong>+7.151ms p99</strong> for cross-cluster paths on a kind cluster. The cross-cluster latency covers the Conduit hop and network traversal, not the eBPF enforcement path which operates in microseconds.</p>
    </article>
  );
}

// ─── Doc: Conduit ─────────────────────────────────────────────────────────────
function DocConduit() {
  return (
    <article className="doc-page">
      <h1>Conduit — Cross-Cluster Gateway</h1>
      <p className="doc-lead">Where eBPF cannot reach — between separate Kubernetes clusters — Conduit handles mTLS wrapping and Sigil-backed identity verification at the cluster boundary.</p>
      <h2>Two deployment modes</h2>
      <ul>
        <li><strong>Conduit Egress</strong> — in the originating cluster. Wraps outbound traffic in mTLS using a Sigil-issued certificate and applies boundary policy before leaving the cluster.</li>
        <li><strong>Conduit Ingress</strong> — in the destination cluster. Receives mTLS-wrapped traffic, verifies the certificate against Sigil, and forwards on success only.</li>
      </ul>
      <h2>Configuration</h2>
      <pre className="codeblock"><code>{`# Source cluster
conduitEgress:
  enabled: true
  peer:
    address: "10.0.2.30:9000"

# Destination cluster
conduitIngress:
  enabled: true
  clusterIdentity: "cluster-b"`}</code></pre>
      <h2>Identity model</h2>
      <p>Both sides use Sigil-issued certificates. Because both clusters trust the same Sigil root CA, no additional certificate distribution or CA federation is needed. The shared root handles cross-cluster identity automatically.</p>
      <h2>Telemetry</h2>
      <p>Cross-cluster events are emitted to Trace tagged with the source cluster ID. In Trace, cross-cluster edges appear separately from same-cluster edges.</p>
    </article>
  );
}

// ─── Doc: Trace ───────────────────────────────────────────────────────────────
function DocTrace() {
  return (
    <article className="doc-page">
      <h1>Trace — Observability</h1>
      <p className="doc-lead">MeshLite's built-in observability dashboard. Live service topology, policy event feed, latency distribution, and cross-cluster traffic — in one container, without any additional monitoring infrastructure.</p>
      <h2>What Trace shows</h2>
      <ul>
        <li><strong>Service topology graph</strong> — auto-discovered from eBPF telemetry. Edges show ALLOW / DENY state and cross-cluster classification in real time.</li>
        <li><strong>Policy event feed</strong> — every decision with source, destination, action, and timestamp. Incident triage in seconds.</li>
        <li><strong>Latency distribution</strong> — p50 and p99 per edge, continuously updated.</li>
        <li><strong>Denial feed</strong> — filtered view of denied requests for security auditing.</li>
        <li><strong>Cross-cluster edges</strong> — Conduit-forwarded paths tagged with origin cluster ID.</li>
      </ul>
      <h2>No external stack required</h2>
      <p>Trace is a single backend container with a React frontend. No Prometheus scrape config. No Kiali CRDs. No Grafana dashboards. Install MeshLite — Trace works.</p>
      <h2>Accessing Trace</h2>
      <pre className="codeblock"><code>{`# Development / kind
kubectl port-forward -n meshlite-system svc/trace 3000:3000
# http://localhost:3000

# Production — enable ingress in values.yaml
trace:
  ingress:
    enabled: true
    host: trace.yourdomain.com`}</code></pre>
      <h2>Terminal companion</h2>
      <pre className="codeblock"><code>{`meshctl logs --service service-api --trace-url http://trace.meshlite-system:3000
meshctl status --trace-url http://trace.meshlite-system:3000`}</code></pre>
    </article>
  );
}

// ─── Doc: meshctl Reference ───────────────────────────────────────────────────
function DocMeshctlRef() {
  return (
    <article className="doc-page">
      <h1>meshctl Reference</h1>
      <p className="doc-lead">Full operational coverage — apply policy, check health, verify access, stream events, rotate certificates — from a single binary with no dependencies.</p>
      <h2>Commands</h2>
      <table className="doc-table">
        <thead><tr><th>Command</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>meshctl version</code></td><td>Print build version, commit hash, and platform</td></tr>
          <tr><td><code>meshctl status</code></td><td>Show Sigil and Trace health, agent count, connected nodes</td></tr>
          <tr><td><code>meshctl apply -f FILE</code></td><td>Apply a mesh.yaml policy file to Sigil</td></tr>
          <tr><td><code>meshctl verify --from X --to Y</code></td><td>Predict whether current policy allows X → Y</td></tr>
          <tr><td><code>meshctl logs --service S</code></td><td>Stream recent Trace events for a named service</td></tr>
          <tr><td><code>meshctl rotate --service S</code></td><td>Request immediate certificate rotation</td></tr>
        </tbody>
      </table>
      <h2>Global flags</h2>
      <table className="doc-table">
        <thead><tr><th>Flag</th><th>Default</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>--sigil-url</code></td><td><code>http://localhost:8080</code></td><td>Sigil HTTP/gRPC address</td></tr>
          <tr><td><code>--trace-url</code></td><td><code>http://localhost:3000</code></td><td>Trace HTTP address</td></tr>
          <tr><td><code>--kubeconfig</code></td><td><code>~/.kube/config</code></td><td>Path to kubeconfig</td></tr>
          <tr><td><code>--namespace</code></td><td><code>meshlite-system</code></td><td>Kubernetes namespace</td></tr>
        </tbody>
      </table>
      <h2>Examples</h2>
      <pre className="codeblock"><code>{`# Apply policy
meshctl apply -f ./mesh.yaml --sigil-url http://sigil.meshlite-system:8080

# Verify access before deploying
meshctl verify --from new-service --to payments \\
  --sigil-url http://sigil.meshlite-system:8080
# → ALLOW

# Live event stream during an incident
meshctl logs --service payments \\
  --trace-url http://trace.meshlite-system:3000

# Scheduled cert rotation
meshctl rotate --service payments \\
  --sigil-url http://sigil.meshlite-system:8080`}</code></pre>
    </article>
  );
}

// ─── Doc: Policy ──────────────────────────────────────────────────────────────
function DocPolicy() {
  return (
    <article className="doc-page">
      <h1>Policy Model</h1>
      <p className="doc-lead">MeshLite policy is intentionally simple: a YAML list of rules. Each rule names a source, a destination, and an action. That is everything.</p>
      <h2>Format</h2>
      <pre className="codeblock"><code>{`policies:
  - from: service-frontend
    to: service-api
    action: ALLOW

  - from: service-api
    to: service-db
    action: ALLOW

  - from: "*"
    to: service-internal
    action: DENY`}</code></pre>
      <h2>Evaluation rules</h2>
      <ul>
        <li>Rules are evaluated in order — first match wins.</li>
        <li><code>"*"</code> in <code>from</code> matches any source service.</li>
        <li>No matching rule → default action is <strong>DENY</strong>.</li>
        <li>Changes are pushed to all Kprobe agents within seconds of <code>meshctl apply</code>.</li>
      </ul>
      <h2>Apply and verify</h2>
      <pre className="codeblock"><code>{`meshctl apply -f mesh.yaml --sigil-url http://sigil.meshlite-system:8080

meshctl verify --from service-frontend --to service-api \\
  --sigil-url http://sigil.meshlite-system:8080
# → ALLOW

meshctl verify --from external --to service-internal \\
  --sigil-url http://sigil.meshlite-system:8080
# → DENY`}</code></pre>
    </article>
  );
}

// ─── Doc: Multi-cluster ───────────────────────────────────────────────────────
function DocMultiCluster() {
  return (
    <article className="doc-page">
      <h1>Multi-Cluster Setup</h1>
      <p className="doc-lead">Cross-cluster enforcement through Conduit. Each cluster runs its own Kprobe DaemonSet. All clusters share one Sigil instance as their root CA.</p>
      <h2>Topology</h2>
      <table className="doc-table">
        <thead><tr><th>Cluster</th><th>Components</th></tr></thead>
        <tbody>
          <tr><td><strong>Cluster A</strong> (source)</td><td>Sigil (shared root), Kprobe, Conduit Egress</td></tr>
          <tr><td><strong>Cluster B</strong> (destination)</td><td>Kprobe, Conduit Ingress (points at Sigil in Cluster A)</td></tr>
        </tbody>
      </table>
      <h2>Cluster A values.yaml</h2>
      <pre className="codeblock"><code>{`sigil:
  enabled: true

kprobe:
  cluster:
    id: "cluster-a"
  sigil:
    address: "sigil.meshlite-system:8080"
  trace:
    address: "trace.meshlite-system:3000"

conduitEgress:
  enabled: true
  peer:
    address: "10.0.2.30:9000"`}</code></pre>
      <h2>Cluster B values.yaml</h2>
      <pre className="codeblock"><code>{`sigil:
  enabled: false

kprobe:
  cluster:
    id: "cluster-b"
  sigil:
    address: "10.0.1.10:8080"
  trace:
    address: "10.0.1.10:3000"

conduitIngress:
  enabled: true
  clusterIdentity: "cluster-b"`}</code></pre>
      <h2>Validate</h2>
      <pre className="codeblock"><code>{`meshctl status --sigil-url http://sigil.meshlite-system:8080
# Agents from both cluster-a and cluster-b should appear

meshctl verify --from service-a --to service-b \\
  --sigil-url http://sigil.meshlite-system:8080`}</code></pre>
    </article>
  );
}

const DOC_MAP = {
  overview: DocOverview, architecture: DocArchitecture,
  "quickstart-same": QuickstartSame, "quickstart-cross": QuickstartCross,
  "helm-install": DocHelmInstall, "helm-values": DocHelmValues, "meshctl-install": DocMeshctlInstall,
  sigil: DocSigil, kprobe: DocKprobe, conduit: DocConduit, trace: DocTrace,
  "meshctl-ref": DocMeshctlRef, policy: DocPolicy, multicluster: DocMultiCluster,
};

// ─── Docs shell ───────────────────────────────────────────────────────────────
function DocSidebar({ current, onChange }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!query.trim()) return DOC_NAV;
    const q = query.toLowerCase();
    return DOC_NAV
      .map((g) => ({
        ...g,
        items: g.items.filter((it) =>
          it.label.toLowerCase().includes(q) || (it.sub || "").toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <nav className="doc-sidebar">
      <div className="doc-search-wrap">
        <input
          className="doc-search-input"
          type="search"
          placeholder="Search docs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search documentation"
        />
      </div>
      {filtered.map(({ group, items }) => (
        <div className="doc-nav-group" key={group}>
          <span className="doc-group-label">{group}</span>
          {items.map(({ id, label, icon, sub }) => (
            <button
              key={id}
              className={`doc-nav-btn${current === id ? " active" : ""}`}
              onClick={() => { onChange(id); window.scrollTo(0, 0); }}
            >
              {icon && <span className="doc-nav-icon">{icon}</span>}
              <span className="doc-nav-label">{label}</span>
              {sub && <span className="doc-nav-sub">{sub}</span>}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function DocsPage() {
  const [section, setSection] = useState("overview");
  const [headings, setHeadings] = useState([]);
  const contentRef = useRef(null);
  const Content = DOC_MAP[section] || DocOverview;

  useEffect(() => {
    if (!contentRef.current) return;
    const els = contentRef.current.querySelectorAll("h2");
    const items = Array.from(els).map((el, i) => {
      if (!el.id) el.id = `doc-h-${i}`;
      return { id: el.id, text: el.textContent };
    });
    setHeadings(items);
  }, [section]);

  return (
    <DocNavContext.Provider value={setSection}>
      <div className="docs-layout">
        <DocSidebar current={section} onChange={setSection} />
        <main className="docs-content" ref={contentRef}>
          <Content />
        </main>
        {headings.length > 0 && (
          <aside className="docs-toc">
            <span className="toc-label">On this page</span>
            {headings.map((h) => (
              <a key={h.id} href={`#${h.id}`} className="toc-link">{h.text}</a>
            ))}
          </aside>
        )}
      </div>
    </DocNavContext.Provider>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-row">
        <span className="brand">MeshLite</span>
        <span className="footer-note">Zero-trust networking for Kubernetes · Alpha</span>
        <a href="https://github.com/andrew-william-dev/Meshlite" target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </footer>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("home");
  return (
    <div className="app-root">
      <Topbar page={page} setPage={setPage} />
      {page === "home" ? <HomePage onDocsClick={() => setPage("docs")} /> : <DocsPage />}
      <Footer />
    </div>
  );
}

