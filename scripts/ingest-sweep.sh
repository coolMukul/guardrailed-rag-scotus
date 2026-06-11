#!/usr/bin/env bash
# Ingest the 512- and 1200-token chunk corpora into their own Qdrant
# collections. Run from WSL (Docker networking is reliable there):
#   wsl -d Ubuntu -- bash /mnt/c/m/personalGit/guardrailed-rag-scotus/scripts/ingest-sweep.sh
set -e

cd /mnt/c/m/personalGit/guardrailed-rag-scotus
NODE="$HOME/.nvm/versions/node/v22.22.3/bin/node"
export DATA_DIR=/mnt/c/m/data

echo "Ingesting 512-token corpus..."
"$NODE" node_modules/tsx/dist/cli.mjs scripts/ingest-qdrant.ts \
  --collection scotus_opinions_512 --chunks-dir /mnt/c/m/data/scotus/chunks-512 \
  > reports/ingest-512.log 2>&1

echo "Ingesting 1200-token corpus..."
"$NODE" node_modules/tsx/dist/cli.mjs scripts/ingest-qdrant.ts \
  --collection scotus_opinions_1200 --chunks-dir /mnt/c/m/data/scotus/chunks-1200 \
  > reports/ingest-1200.log 2>&1

echo "Done."
