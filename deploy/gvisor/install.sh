#!/bin/sh
# Installs gVisor on this server and registers it with Docker as "runsc".
#
#   sudo sh deploy/gvisor/install.sh
#   then set RUNTIME_OCI_RUNTIME=runsc in deploy/production.env and restart
#   the api and worker.
#
# Run as root on the Linux server that runs users' code. Downloads one pinned
# release, checks it against the checksum gVisor publishes, and adds a runtime
# entry to /etc/docker/daemon.json (keeping anything already there).
#
# Two runtime arguments are required, and each was found by running the
# platform's own test suites under gVisor:
#   --overlay2=none   Without it, gVisor keeps a workload's file writes inside
#                     the sandbox, so the platform cannot read the workspace back
#                     and cannot measure disk use.
#   --network=host    "host" here is the container's own network namespace — the
#                     project's isolated network — not the server's. Without it,
#                     gVisor's own network stack cannot reach Docker's DNS, so no
#                     name resolves: not other containers, not package registries.
#                     Every other system call still goes through gVisor.
set -eu

VERSION="${GVISOR_VERSION:-20260914.0}"
ARCH="$(uname -m)"
URL="https://storage.googleapis.com/gvisor/releases/release/${VERSION}/${ARCH}"
DEST=/usr/local/lib/gvisor
DAEMON=/etc/docker/daemon.json

[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is needed to edit $DAEMON safely." >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
echo "downloading gVisor $VERSION for $ARCH"
curl -fsSL -o gvisor.tar.bz2 "$URL/gvisor.tar.bz2"
curl -fsSL -o gvisor.tar.bz2.sha512 "$URL/gvisor.tar.bz2.sha512"
sha512sum -c gvisor.tar.bz2.sha512

mkdir -p "$DEST"
tar xjf gvisor.tar.bz2 -C "$DEST"
ln -sf "$DEST/runsc" /usr/local/bin/runsc
ln -sf "$DEST/containerd-shim-runsc-v1" /usr/local/bin/containerd-shim-runsc-v1
runsc --version | head -1

mkdir -p "$(dirname "$DAEMON")"
[ -f "$DAEMON" ] || echo '{}' > "$DAEMON"
cp "$DAEMON" "$DAEMON.before-gvisor"
python3 - "$DAEMON" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    config = json.load(f)
config.setdefault("runtimes", {})["runsc"] = {
    "path": "/usr/local/bin/runsc",
    "runtimeArgs": ["--overlay2=none", "--network=host"],
}
with open(path, "w") as f:
    json.dump(config, f, indent=2)
PY

systemctl restart docker
echo "checking a container really runs under gVisor:"
docker run --rm --runtime=runsc alpine:3.20 uname -r | grep -q gvisor && echo "  ok — kernel reports gvisor"
echo "Now set RUNTIME_OCI_RUNTIME=runsc in deploy/production.env and restart the api and worker."
