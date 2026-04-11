#!/bin/sh
set -e
cd /mnt/d/Projects/MeshLite
export HOME=/home/andre
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/andre/go/bin
protoc \
  --go_out=sigil/internal/proto \
  --go_opt=paths=source_relative \
  --go-grpc_out=sigil/internal/proto \
  --go-grpc_opt=paths=source_relative \
  --proto_path=sigil/proto \
  sigil/proto/sigil.proto
echo "OK: proto regenerated"
