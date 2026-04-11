# syntax=docker/dockerfile:1

FROM node:20-bookworm AS ui-builder
WORKDIR /src
COPY trace/frontend/package.json trace/frontend/tsconfig.json trace/frontend/vite.config.ts trace/frontend/index.html ./trace/frontend/
COPY trace/frontend/src ./trace/frontend/src
RUN cd trace/frontend && npm install && npm run build

FROM golang:1.25-bookworm AS go-builder
WORKDIR /src
COPY trace/backend ./trace/backend
WORKDIR /src/trace/backend
RUN go mod tidy && go build -o /out/trace-server ./cmd/server

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=go-builder /out/trace-server /app/trace-server
COPY --from=ui-builder /src/trace/frontend/dist /app/web
EXPOSE 3000 9090
ENTRYPOINT ["/app/trace-server"]
