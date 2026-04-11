#!/bin/sh
set -e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/home/andre/go/bin
cd /mnt/d/Projects/MeshLite/sigil
echo "--- go build sigil ---"
go build ./...
echo "--- go vet sigil ---"
go vet ./...
echo "--- go test sigil ---"
go test ./...
echo "SIGIL OK"
