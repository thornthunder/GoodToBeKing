#!/bin/bash
# Runs a Bedrock Dedicated Server on Linux with a console other programs can write to
# (echo "say hello" > console.in) and makes the court's operators operator again each time they
# spawn: offline players have no account id, so the server cannot keep their rights on disk.
# The Linux counterpart of start-bds.ps1.
# Usage: run-bds.sh <server directory> [operator ...]   (default operator: Merlin)
set -euo pipefail
dir=${1:?usage: run-bds.sh <server directory> [operator ...]}
shift
ops=("$@")
[ ${#ops[@]} -gt 0 ] || ops=(Merlin)
cd "$dir"
[ -p console.in ] || { rm -f console.in; mkfifo console.in; }
# Held open for reading and writing, so the server never reads end-of-file from its console.
exec 3<>console.in
LD_LIBRARY_PATH=. stdbuf -oL ./bedrock_server <&3 | while IFS= read -r line; do
  printf '%s\n' "$line"
  for name in "${ops[@]}"; do
    case $line in *"Player Spawned: $name xuid"*) echo "op $name" >&3 ;; esac
  done
done
