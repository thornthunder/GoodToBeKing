#!/bin/bash
# Lets the admin (src/admin) start, stop and restart a Bedrock server that systemd runs, and
# nothing more: installs bds-control.sh as root's own copy and a systemd path unit that runs it
# whenever the admin writes <server dir>/.control.
#   sudo server/install-bds-control.sh <service> <server dir>     e.g. bds-test /home/jean/testserver
set -euo pipefail
service=${1:?usage: install-bds-control.sh <service> <server dir>}
dir=${2:?usage: install-bds-control.sh <service> <server dir>}
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -d "$dir" ] || { echo "no such folder: $dir" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
# Root runs its own copy: the checkout is the admin's to write, the copy is not.
install -m 755 -o root -g root "$here/bds-control.sh" /usr/local/sbin/bds-control
cat > "/etc/systemd/system/$service-control.service" <<EOF
[Unit]
Description=Start, stop or restart $service when the admin asks (bds-control)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bds-control $service $dir
EOF
cat > "/etc/systemd/system/$service-control.path" <<EOF
[Unit]
Description=Watch for the admin's wishes for $service

[Path]
PathExists=$dir/.control
Unit=$service-control.service

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$service-control.path"
echo "installed: $service-control.path watches $dir/.control"
