#!/bin/bash
# Carries out what the admin (src/admin/bds.ts) asks of a Bedrock server that systemd runs:
# start, stop or restart its service, or just say how it is. The admin writes the wish to
# <server dir>/.control; a systemd path unit runs this (as root) when that file appears, and the
# answer goes to <server dir>/.control-result. Nothing else is ever run.
# Installed by install-bds-control.sh. Usage: bds-control.sh <service> <server dir>
set -u
service=${1:?usage: bds-control.sh <service> <server dir>}
dir=${2:?usage: bds-control.sh <service> <server dir>}
request="$dir/.control"
[ -f "$request" ] || exit 0
action=$(head -c 16 "$request" | tr -cd 'a-z')
rm -f "$request"
code=0
case $action in
  start | stop | restart) systemctl "$action" "$service" || code=$? ;;
  status) ;;
  *) action="unknown"; code=2 ;;
esac
result="$dir/.control-result"
{
  echo "action=$action"
  echo "code=$code"
  systemctl show "$service" -p ActiveState -p SubState -p MainPID -p ActiveEnterTimestamp
  echo "at=$(date +%s%3N)"
} > "$result.tmp"
chmod 644 "$result.tmp"
mv -f "$result.tmp" "$result"
