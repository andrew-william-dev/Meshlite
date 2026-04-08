# ─── Stage 1: compile eBPF object (bpfel-unknown-none target) ────────────────
FROM rustlang/rust:nightly AS ebpf-builder

RUN cargo install bpf-linker

WORKDIR /build
COPY kprobe/ kprobe/
COPY sigil/proto/ sigil/proto/

# Copy rustup home into the current writable layer before building.
# Without this, rustup channel-sync renames from a read-only lower overlay layer
# to an upper layer and fails with EXDEV (os error 18 — cross-device link).
RUN cp -a /usr/local/rustup /tmp/rustup && \
    cd kprobe && \
    RUSTUP_HOME=/tmp/rustup \
    cargo build --package kprobe-ebpf \
        -Z build-std=core \
        --target bpfel-unknown-none \
        --release

# ─── Stage 2: compile userspace binary (musl for fully static binary) ─────────
FROM rustlang/rust:nightly AS userspace-builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        protobuf-compiler \
        musl-tools && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY kprobe/ kprobe/
COPY sigil/proto/ sigil/proto/

# Copy the compiled eBPF object so the build can reference it.
COPY --from=ebpf-builder \
     /build/kprobe/target/bpfel-unknown-none/release/kprobe-ebpf \
     /build/kprobe/target/bpfel-unknown-none/release/kprobe-ebpf

# Same RUSTUP_HOME trick: move into writable layer, then install components and build.
RUN cp -a /usr/local/rustup /tmp/rustup && \
    RUSTUP_HOME=/tmp/rustup rustup component add rust-src && \
    RUSTUP_HOME=/tmp/rustup rustup target add x86_64-unknown-linux-musl && \
    cd kprobe && \
    RUSTUP_HOME=/tmp/rustup \
    cargo build --package kprobe-userspace \
        --release \
        --target x86_64-unknown-linux-musl

# ─── Stage 3: minimal runtime image ──────────────────────────────────────────
FROM scratch

COPY --from=ebpf-builder \
     /build/kprobe/target/bpfel-unknown-none/release/kprobe-ebpf \
     /app/kprobe-ebpf

COPY --from=userspace-builder \
     /build/kprobe/target/x86_64-unknown-linux-musl/release/kprobe-loader \
     /app/kprobe-loader

ENTRYPOINT ["/app/kprobe-loader"]
