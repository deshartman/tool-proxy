#!/usr/bin/env bash
# Verify that a DEPLOYED connector can actually persist agentic-memory state.
#
# Why this exists as a live check rather than a unit test: the failure it catches
# is a property of the RUNTIME filesystem, not of any code path. A volume mounted
# at /var/lib/tool-proxy shadows the image directory, discarding the
# Dockerfile's mkdir + chown — Fly mounts it root:root 0755, and a K8s PVC or raw
# EFS mount behaves the same. The connector then runs as `mcp` and cannot create
# anything there. connector/entrypoint.sh re-provisions before dropping
# privileges; this script proves it worked on the box you actually deployed.
#
# It is also LAZY in production, which is what makes it worth a deliberate check:
# saveState is called on the first memory write, not at boot, so a broken deploy
# reports healthy and fails much later under real traffic.
#
# Runs three checks as the real `mcp` uid inside the container:
#   1. both state directories exist and are mcp-owned
#   2. saveState's exact sequence succeeds  (mkdir -> .tmp -> chmod -> rename)
#   3. CONTROL: the same write against the still-root-owned volume root fails
#      EACCES. Without this, check 2 passing proves nothing — it would also pass
#      if the container were running everything as root.
#
# Usage:  ./scripts/verify-state-volume.sh [app-name]     (default tool-proxy)
# Exit:   0 all checks pass, 1 any check fails.

set -uo pipefail

APP="${1:-tool-proxy}"
VOL="/var/lib/tool-proxy"
fail=0

say() { printf '%s\n' "$*"; }

if ! command -v fly >/dev/null 2>&1; then
  say "error: fly CLI not on PATH"
  exit 1
fi

say "== $APP: state volume write verification =="

# ---- 1. ownership ----------------------------------------------------------
listing=$(fly ssh console -a "$APP" -C "ls -la $VOL" 2>&1 | tail -n +2)
say "$listing"
for d in agentic-memory customer-mcps; do
  if printf '%s' "$listing" | grep -qE "mcp +mcp .*${d}$"; then
    say "  ok   $d is mcp-owned"
  else
    say "  FAIL $d missing or not mcp-owned"
    fail=1
  fi
done
if printf '%s' "$listing" | grep -qE '^d.* root +root +.* \.$'; then
  say "  ok   volume root still root-owned (least privilege preserved)"
else
  say "  warn volume root is not root-owned — a chown -R may have crept in"
fi

# ---- 2. the real write, as mcp ---------------------------------------------
# Mirrors bundled-mcps/agentic-memory/state.ts saveState(): a sibling .tmp,
# chmod 0600 (384 decimal), rename over the target, chmod again. `node -e` is
# always CommonJS regardless of the nearest package.json "type", so require() is
# safe here.
probe_js="const fs=require('fs'),path=require('path');const p='${VOL}/agentic-memory/.verify-probe.json';try{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p+'.tmp',JSON.stringify({probe:1}));fs.chmodSync(p+'.tmp',384);fs.renameSync(p+'.tmp',p);fs.chmodSync(p,384);const s=fs.statSync(p);console.log('PROBE_OK uid='+process.getuid()+' mode='+(s.mode&511).toString(8));fs.unlinkSync(p)}catch(e){console.log('PROBE_FAIL uid='+process.getuid()+' '+e.code)}"
out=$(fly ssh console -a "$APP" -C "su-exec mcp:mcp node -e \"$probe_js\"" 2>&1 | tail -2)
say "$out"
if printf '%s' "$out" | grep -q 'PROBE_OK.*mode=600'; then
  say "  ok   mcp wrote and renamed state, 0600"
else
  say "  FAIL mcp could not persist state — entrypoint provisioning did not take"
  fail=1
fi

# ---- 3. control ------------------------------------------------------------
ctl_js="const fs=require('fs');try{fs.writeFileSync('${VOL}/.verify-control.tmp','{}');console.log('CTL_UNEXPECTED_OK');fs.unlinkSync('${VOL}/.verify-control.tmp')}catch(e){console.log('CTL_EACCES '+e.code)}"
out=$(fly ssh console -a "$APP" -C "su-exec mcp:mcp node -e \"$ctl_js\"" 2>&1 | tail -2)
say "$out"
if printf '%s' "$out" | grep -q 'CTL_EACCES EACCES'; then
  say "  ok   control denied on root-owned dir — check 2 is meaningful"
else
  say "  FAIL control write SUCCEEDED; the process may be running as root,"
  say "       which would make check 2 vacuous"
  fail=1
fi

say ""
if [ "$fail" -eq 0 ]; then say "PASS"; else say "FAIL"; fi
exit "$fail"
