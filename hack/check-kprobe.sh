#!/bin/sh
set -e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/andre/.cargo/bin
export HOME=/home/andre
cd /mnt/d/Projects/MeshLite/kprobe
echo "--- cargo check ---"
cargo check --package kprobe-userspace 2>&1
echo "--- cargo test ---"
cargo test --package kprobe-userspace 2>&1
echo "KPROBE OK"
