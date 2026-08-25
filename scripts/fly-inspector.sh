#!/usr/bin/env bash
# Open the connector's Inspector in your browser, for a connector running on
# Fly.io. Starts what's needed, prints a URL, and tears everything down when
# you press Ctrl-C.
#
#   ./scripts/fly-inspector.sh                 # app read from deploy/fly/fly.toml
#   ./scripts/fly-inspector.sh <app>
#   ./scripts/fly-inspector.sh <app> <local-port>
#
# WHY THIS EXISTS
#
# The Inspector is loopback-only, deliberately and permanently: every route
# except four machine-API paths (/oauth/token, /v1/*) refuses a caller that
# isn't 127.0.0.1. Adding API clients in the Network Access panel does NOT
# change that — those are credentials for scripts, not for a browser.
#
# On every other platform an admin has a way to become loopback: `ssh -L`
# makes the remote sshd dial localhost for you, `kubectl port-forward` enters
# the pod's network namespace, `docker exec` runs inside the container. Fly
# has neither — `fly proxy` stops at the Machine's fdaa: mesh address and
# `fly ssh` has no -L — so `fly proxy 9090:9090` alone returns
# 403 {"error":"forbidden: loopback only"} on every dashboard route.
#
# This script supplies the missing hop: a small relay inside the Machine
# forwards to 127.0.0.1:9090, so the Inspector's caller really is loopback.
#
# WHAT IT TRADES AWAY, AND WHY THE TEARDOWN MATTERS
#
# The relay does not authenticate. It launders the source address, so while
# it runs, any peer on your Fly organization's private network can reach the
# full dashboard — including the Webhooks panel, where the URL itself is the
# secret. That is why this script owns the lifecycle: both processes die on
# Ctrl-C, and the relay also expires on its own after RELAY_TTL_SECONDS in
# case this script is killed uncleanly. Leaving a relay running by accident
# is the failure mode worth engineering against.

set -uo pipefail

INSPECTOR_PORT=9090          # the Inspector's port inside the Machine
RELAY_PORT=9099              # the relay's port inside the Machine
RELAY_TTL_SECONDS=3600       # relay self-exits after this, even if orphaned
# Unique token in the relay's command line so teardown can target exactly
# this run's relay with `pkill -f`, leaving a concurrent admin's alone.
RELAY_MARKER_BASE="MCPINSP_RELAY"
RELAY_MARKER=""
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

APP="${1:-}"
LOCAL_PORT="${2:-}"
LOCAL_PORT_EXPLICIT=1
if [ -z "$LOCAL_PORT" ]; then LOCAL_PORT=9099; LOCAL_PORT_EXPLICIT=0; fi

# Default the app name from the checked-in fly.toml so the common case is
# zero-argument.
if [ -z "$APP" ] && [ -f "$ROOT/deploy/fly/fly.toml" ]; then
  APP=$(sed -n 's/^app *= *"\([^"]*\)".*/\1/p' "$ROOT/deploy/fly/fly.toml" | head -1)
fi
if [ -z "$APP" ]; then
  echo "usage: $0 <app> [local-port]" >&2
  echo "  (or run from a checkout with deploy/fly/fly.toml present)" >&2
  exit 2
fi

relay_pid=""
proxy_pid=""
relay_log=$(mktemp -t flyinsp-relay)
proxy_log=$(mktemp -t flyinsp-proxy)

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "==> shutting down"
  [ -n "$proxy_pid" ] && kill "$proxy_pid" 2>/dev/null && echo "    proxy stopped"
  [ -n "$relay_pid" ] && kill "$relay_pid" 2>/dev/null

  # Killing the local ssh client does NOT reliably kill the remote child: the
  # relay is parented to hallpass, and a hand-run one has been observed
  # outliving its terminal for hours, leaving the dashboard reachable from the
  # org's private network. So tear it down explicitly and then CHECK, rather
  # than assuming.
  if [ -n "$RELAY_MARKER" ]; then
    fly ssh console -a "$APP" -C "pkill -f $RELAY_MARKER" >/dev/null 2>&1
    left=$(fly ssh console -a "$APP" -C "ps -o args" 2>/dev/null | grep -c "$RELAY_MARKER" || true)
    if [ "${left:-0}" -eq 0 ]; then
      echo "    relay stopped inside the Machine (verified)"
    else
      echo "" >&2
      echo "    WARNING: a relay is still running inside $APP." >&2
      echo "    It self-expires within $((RELAY_TTL_SECONDS / 60)) minutes. To stop it now:" >&2
      echo "      fly ssh console -a $APP -C \"pkill -f $RELAY_MARKER\"" >&2
    fi
  fi
  rm -f "$relay_log" "$proxy_log"
  exit 0
}
trap cleanup EXIT INT TERM

command -v fly >/dev/null 2>&1 || { echo "error: fly CLI not on PATH" >&2; exit 1; }

echo "==> $APP"

# A public IP means this Machine is reachable from the internet, and the
# relay would widen what that exposes. Refuse rather than warn.
ips=$(fly ips list -a "$APP" 2>/dev/null | grep -cE '^\s*v[46]|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || true)
if [ "${ips:-0}" -gt 0 ]; then
  echo "error: $APP has a public IP allocated. Release it before using this" >&2
  echo "       script — the connector is outbound-only and the relay would" >&2
  echo "       widen what a public IP already exposes." >&2
  exit 1
fi

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# An explicitly requested port is honoured or refused — the admin may need a
# specific URL. A defaulted port just moves out of the way; the URL is printed
# below either way, so there is nothing for them to work out.
if ! port_free "$LOCAL_PORT"; then
  if [ "$LOCAL_PORT_EXPLICIT" = "1" ]; then
    echo "error: local port $LOCAL_PORT is already in use (a local dev inspector?)." >&2
    exit 1
  fi
  for cand in 9100 9101 19099 19100; do
    if port_free "$cand"; then LOCAL_PORT=$cand; break; fi
  done
  if ! port_free "$LOCAL_PORT"; then
    echo "error: no free local port found (tried 9099-9101, 19099-19100)." >&2
    exit 1
  fi
fi

# ── 1. relay inside the Machine ────────────────────────────────────────────
# Exits on stdin EOF (channel closed) and after RELAY_TTL_SECONDS regardless,
# so an orphaned listener is bounded. The hand-run recipe this replaces had
# neither, which is how a test relay outlived its terminal and kept the
# dashboard reachable for hours. `node -e` is always CommonJS.

start_relay() {   # $1 = port inside the Machine. 0 = up, 1 = port taken, 2 = fatal
  local port="$1"
  local js="/*${RELAY_MARKER_BASE}_${port}*/const net=require('net');setTimeout(()=>{console.log('relay expired');process.exit(0)},${RELAY_TTL_SECONDS}000);net.createServer(c=>{const u=net.connect(${INSPECTOR_PORT},'127.0.0.1');c.pipe(u);u.pipe(c);c.on('error',()=>{});u.on('error',()=>{})}).listen(${port},'::',()=>console.log('relay up')).on('error',e=>{console.log('relay failed: '+e.code);process.exit(1)});"
  : > "$relay_log"
  fly ssh console -a "$APP" -C "node -e \"$js\"" >> "$relay_log" 2>&1 &
  relay_pid=$!
  local i
  for i in $(seq 1 40); do
    grep -q 'relay up' "$relay_log" 2>/dev/null && return 0
    grep -q 'relay failed: EADDRINUSE' "$relay_log" 2>/dev/null && return 1
    if grep -q 'relay failed' "$relay_log" 2>/dev/null; then return 2; fi
    kill -0 "$relay_pid" 2>/dev/null || return 2
    sleep 0.5
  done
  return 2
}

echo "==> starting relay inside the Machine (-> 127.0.0.1:$INSPECTOR_PORT)"
relay_ok=0
for candidate in "$RELAY_PORT" 9100 9101 9102; do
  start_relay "$candidate"
  case $? in
    0) RELAY_PORT="$candidate"; RELAY_MARKER="${RELAY_MARKER_BASE}_${candidate}"; relay_ok=1; break ;;
    1) echo "    :$candidate busy inside the Machine (leftover relay?), trying next"
       kill "$relay_pid" 2>/dev/null; relay_pid="" ;;
    2) echo "error: relay could not start inside the Machine:" >&2
       tail -4 "$relay_log" >&2; exit 1 ;;
  esac
done
if [ "$relay_ok" != "1" ]; then
  echo "error: no free relay port inside the Machine (tried 9099-9102)." >&2
  echo "       An earlier relay may be orphaned. Inspect with:" >&2
  echo "         fly ssh console -a $APP -C \"ps -o pid,args\" | grep createServer" >&2
  exit 1
fi
echo "    relay up on :$RELAY_PORT"

# ── 2. WireGuard tunnel to the relay ───────────────────────────────────────
echo "==> starting fly proxy ($LOCAL_PORT -> :$RELAY_PORT)"
fly proxy "$LOCAL_PORT:$RELAY_PORT" -a "$APP" > "$proxy_log" 2>&1 &
proxy_pid=$!

# ── 3. Prove the Inspector actually answers, rather than trusting the tunnel.
# A 403 here means the relay is not in the path and we would otherwise hand
# over a URL that renders nothing.
url="http://localhost:$LOCAL_PORT/"
code=""
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
  [ "$code" = "200" ] && break
  kill -0 "$proxy_pid" 2>/dev/null || { echo "error: fly proxy exited:" >&2; tail -3 "$proxy_log" >&2; exit 1; }
  sleep 0.5
done

if [ "$code" != "200" ]; then
  echo "error: Inspector did not answer 200 (got '${code:-no response}')." >&2
  if [ "$code" = "403" ]; then
    echo "       403 means the request reached the Inspector but not over" >&2
    echo "       loopback — the relay is not in the path." >&2
  fi
  tail -3 "$proxy_log" >&2
  exit 1
fi

cat <<EOM

  Inspector ready:  $url

  Use http:// explicitly — Chrome's HSTS on localhost can force https://,
  which the Inspector does not serve (ERR_CONNECTION_RESET).

  NOTE: while this is open, the dashboard is reachable from your Fly
  organization's private network. Press Ctrl-C when you are done.
  The relay also self-expires after $((RELAY_TTL_SECONDS / 60)) minutes.

EOM

# Block until Ctrl-C; surface either child dying.
while kill -0 "$relay_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do
  sleep 1
done
echo "error: a child process exited unexpectedly" >&2
tail -3 "$relay_log" "$proxy_log" >&2
