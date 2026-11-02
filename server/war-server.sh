#!/bin/bash
# The war server: a second Bedrock Dedicated Server next to the test server, for the war game
# (compose.war.yaml), run as the court's own user with no systemd: run-bds.sh keeps its console
# open (console.in) for the referee's commands. A copy of the test server's program with its own
# world and ports (19134/19135, survival, normal, PvP on).
#   server/war-server.sh make <test server dir> <war server dir>   copy the program, new world
#   server/war-server.sh start <war server dir>                    in the background
#   server/war-server.sh stop <war server dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
case ${1:-} in
  make)
    from=${2:?usage: war-server.sh make <test server dir> <war server dir>}
    dir=${3:?usage: war-server.sh make <test server dir> <war server dir>}
    mkdir -p "$dir"
    # The program and its data, not the test world nor its players (no rsync on the VM).
    cp -a "$from/." "$dir/"
    rm -rf "$dir/worlds" "$dir/console.in" "$dir/console.log" "$dir"/*.bak* \
      "$dir/allowlist.json" "$dir/permissions.json" "$dir/.control" "$dir/.control-result"
    sed -i -E \
      -e 's/^server-name=.*/server-name=The war game/' \
      -e 's/^server-port=.*/server-port=19134/' \
      -e 's/^server-portv6=.*/server-portv6=19135/' \
      -e 's/^level-name=.*/level-name=war/' \
      -e 's/^gamemode=.*/gamemode=survival/' \
      -e 's/^difficulty=.*/difficulty=normal/' \
      -e 's/^allow-cheats=.*/allow-cheats=true/' \
      -e 's/^online-mode=.*/online-mode=false/' \
      -e 's/^max-players=.*/max-players=20/' \
      "$dir/server.properties"
    grep -q '^pvp=' "$dir/server.properties" || echo 'pvp=true' >> "$dir/server.properties"
    echo "the war server is in $dir (world: war, port 19134)"
    ;;
  start)
    dir=${2:?usage: war-server.sh start <war server dir>}
    if pgrep -f "run-bds.sh $dir" > /dev/null; then echo "already running"; exit 0; fi
    setsid nohup "$here/run-bds.sh" "$dir" >> "$dir/console.log" 2>&1 < /dev/null &
    echo "the war server starts (log: $dir/console.log)"
    ;;
  stop)
    dir=${2:?usage: war-server.sh stop <war server dir>}
    [ -p "$dir/console.in" ] && echo stop > "$dir/console.in" || true
    sleep 8
    pkill -f "run-bds.sh $dir" || true
    echo "the war server is stopped"
    ;;
  *)
    echo "usage: war-server.sh make|start|stop ..." >&2
    exit 2
    ;;
esac
