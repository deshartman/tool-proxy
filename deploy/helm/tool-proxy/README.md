# tool-proxy Helm chart

Deploys a single-replica tool-proxy to a Kubernetes cluster.

## Install

One secret, one flag. Everything else is configured after the pod is running.

```bash
helm install my-connector ./deploy/helm/tool-proxy \
  --set image.tag=0.1.0 \
  --set secrets.connectorKeyB64="$(head -c 32 /dev/urandom | base64)"
```

That is the whole install. There is no second "db mode" form and no
credentials to paste — the connector's config store is a sealed JSON file on
the PVC, and the controller URL, connector name and auth posture are entered
in the inspector's Configure Tunnel modal below.

Prior versions of this chart `required` `secrets.tunnelAuthToken` (or three
`OAUTH_*` values) and `secrets.postgresUrl`. Those were retired by ENV-TO-DB
and DB-TO-FILE respectively, which means **`helm install` could not succeed at
all** without supplying credentials the connector would then ignore. If you are
carrying a values override from that era, delete those keys yourself: Helm
silently accepts values no template reads, so a stale `secrets.postgresUrl`
produces no warning — it just sits in the release looking meaningful.

In production, source `connectorKeyB64` from External Secrets / sealed-secrets /
the Secrets Store CSI driver rather than `--set`, which lands the key in your
shell history and in the Helm release. Generate it with a command; never paste
key bytes into a ticket or a chat.

## First connect

The chart does not create a Service, so port-forward the **deployment**:

```bash
kubectl port-forward deploy/my-connector 9090:9090
# open http://localhost:9090/   (explicit http:// — Chrome's HSTS on
#                                localhost will otherwise force https://,
#                                which the inspector does not serve)
```

`kubectl port-forward` enters the pod's network namespace, so the connector
sees a genuine loopback caller and the dashboard renders. That matters: every
route except four machine-API paths refuses a non-loopback caller, permanently
and with no opt-out. Fill in Configure Tunnel — controller URL, connector name
matching the controller's Tunnel Security row exactly (case-sensitive), and the
auth posture matching that row — and the status pill goes
`closed → connecting → open`.

This modal is the **only** way to set tunnel identity. There is no CLI
subcommand and no env var, so the port-forward is not a convenience: a fresh
deployment cannot complete first-connect without it.

## No Service for the inspector

By design. The inspector binds `127.0.0.1` inside the pod because the
Webhooks panel exposes bcrypt-protected callback URLs — exposing them
via a Service would defeat the entire secret model. Setting
`networkAccess.enabled: true` renders a Service for the **machine API** only
(`/oauth/token` plus three `/v1/*` routes, each doing its own bearer check);
the dashboard never becomes reachable that way under any configuration.

## Chart layout

| File | Purpose |
|------|---------|
| `Chart.yaml` | metadata |
| `values.yaml` | defaults |
| `templates/_helpers.tpl` | naming + labels |
| `templates/secret.yaml` | the master key, as `CONNECTOR_KEY_B64` |
| `templates/pvc.yaml` | 64 Mi PVC — the sealed config store + agentic-memory state |
| `templates/deployment.yaml` | single-replica deployment |
| `templates/service.yaml` | machine-API Service, only when `networkAccess.enabled` |

Pinned by
[`connector/tests/deploy/helm-chart-lint.test.ts`](../../../connector/tests/deploy/helm-chart-lint.test.ts),
which checks (a) the two env vars the connector needs render outside every
conditional, (b) every `required` in a template names a key `values.yaml` still
declares, and (c) the memory request clears the 1 Gi floor.

## The PVC is the connector's identity

`state/config.json` on that volume holds the sealed tunnel bearer and the
registration token the controller issued. Consequences:

- **Deleting the PVC is not a harmless reset.** The operator must re-run
  Configure Tunnel, and the re-register collides on `name_taken` against the
  controller's surviving row until someone clears it. (An unknown *registration
  token* self-heals silently; a taken *name* needs a human.)
- **Back it up with the key or not at all.** A volume snapshot without
  `connectorKeyB64` decrypts to nothing — which is the point.
- **Rotating the key does not re-seal the store.** `ConfigStore.open()`
  compares a fingerprint and refuses to start against a store sealed with a
  different key. Rotation means keeping the old key, or discarding the PVC and
  reconfiguring.

The PVC root arrives root-owned, as every CSI driver mounts it, so
`entrypoint.sh` creates and chowns the `state/` subdirectory while it is still
root. That is why the store lives in a subdirectory rather than at the volume
root — see `DEFAULT_STATE_DIR` in `connector/src/config-store/store-file.ts`.

## What this chart does NOT do

- Provision a database. It needs none.
- Mount a `connector.yaml`. The yaml is optional; the only shape that still
  requires an entry is a hand-written Type 1 MCP (its own `server.ts`).
- Mount customer MCPs. Use a derived image or add a volume for
  `/var/lib/tool-proxy/customer-mcps` — see
  [`deploy/DERIVED-IMAGE.md`](../../DERIVED-IMAGE.md) and
  [`deploy/VOLUME-MOUNT.md`](../../VOLUME-MOUNT.md).
- Set a `securityContext`. The entrypoint needs root briefly to chown the
  volume and decode the key, then drops to `mcp` via `su-exec`. A cluster
  enforcing a `restricted` Pod Security Standard will reject the pod.
- Create Service / Ingress / LB for the dashboard. Deliberate — see above.
- Handle secret rotation. See the PVC note above; rotation is not a `helm
  upgrade` away.

## Reconnect strategy

Configure `policy.reconnect.enabled` in your `connector.yaml` (mounted
separately from the chart today). Two coherent shapes:

- **`true` (in-process, default).** Connector redials in-place, pod stays Ready.
- **`false` (kubelet-managed).** Connector exits non-zero on close, kubelet
  restarts the pod. Useful if your operations team uses pod status as
  ground truth.
