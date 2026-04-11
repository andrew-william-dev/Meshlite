#!/bin/sh
set -e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/home/andre/.cargo/bin
export HOME=/home/andre
export DOCKER_HOST=unix:///var/run/docker.sock

cd /mnt/d/Projects/MeshLite

echo "=== Building Sigil Docker image ==="
docker build -t meshlite/sigil:phase3 sigil/

echo "=== Building kprobe Docker image ==="
docker build -t meshlite/kprobe:phase3 -f kprobe/Dockerfile .

echo "=== Loading images into kind ==="
kind load docker-image meshlite/sigil:phase3    --name meshlite-dev
kind load docker-image meshlite/kprobe:phase3   --name meshlite-dev

echo "=== DONE: images loaded ==="
