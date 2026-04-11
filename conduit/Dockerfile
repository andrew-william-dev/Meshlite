# Stage 1: Build the conduit binary.
# The meshlite-tls crate is a path dependency at ../crates/meshlite-tls,
# so we copy it alongside the conduit source.
FROM rust:1.86-slim AS builder

# System deps for ring / aws-lc-rs (OpenSSL not needed — ring is used).
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    libclang-dev \
    clang \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy meshlite-tls (path dependency).
COPY crates/meshlite-tls crates/meshlite-tls

# Copy conduit source.
COPY conduit conduit

WORKDIR /build/conduit
RUN cargo build --release

# Stage 2: Minimal runtime image.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/conduit/target/release/conduit /app/conduit

EXPOSE 9090 443

ENTRYPOINT ["/app/conduit"]
