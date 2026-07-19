# GCP GKE

Run the connector as a one-replica Deployment on GKE.

## Prereqs

- Image pushed to Artifact Registry.
- A GKE cluster (Autopilot is fine).
- A Tunnel Security row on the controller (Tools → Connectors → Tunnel
  Security) — see the [overview](./README.md). Pick the credential shape
  that matches the row's type: `ts_<...>` bearer (Twilio Auth Token /
  API Key) or `client_id` + `client_secret` + token URL (OAuth 2.0).
- A Secret Manager secret containing either the `ts_<...>` bearer
  (`TUNNEL_AUTH_TOKEN`) or the OAuth pair (`OAUTH_CLIENT_ID` +
  `OAUTH_CLIENT_SECRET`), plus a ConfigMap or Secret containing the YAML.

## Footgun

**Don't use Cloud Run.** Cloud Run is a good first instinct ("just give me a
container") but it terminates idle connections at 60 minutes max, kills
instances when the request count is zero, and doesn't support persistent
client-initiated WebSockets at all in the gen-1 stack. Use GKE (or Compute
Engine + a systemd unit) instead.

GKE Autopilot is fine. Just make sure the Deployment is `replicas: 1` and
you don't put a Service of type LoadBalancer in front of it (nothing
inbound — see [README](./README.md)).

## Recommended manifests

```yaml
apiVersion: v1
kind: Secret
metadata: { name: mcp-connector-token }
type: Opaque
stringData:
  # ONE of the two postures, matching the controller's Tunnel Security row.
  # Synced from Secret Manager via the CSI driver (link below).
  #
  # ── Twilio Auth Token / API Key row ──
  TUNNEL_AUTH_TOKEN: "REPLACE_VIA_SECRET_MANAGER_SYNC"
  # ── OAuth 2.0 row ──
  # OAUTH_CLIENT_ID: "REPLACE_VIA_SECRET_MANAGER_SYNC"
  # OAUTH_CLIENT_SECRET: "REPLACE_VIA_SECRET_MANAGER_SYNC"
---
apiVersion: v1
kind: ConfigMap
metadata: { name: mcp-connector-config }
data:
  config.yaml: |
    # ── env mode only ──
    # This block is READ only when CONNECTOR_CREDS_SOURCE=env (legacy mode).
    # Under the default `db` mode, tunnel identity lives in a sealed Postgres
    # row managed via the inspector's Configure Tunnel modal — no yaml block
    # needed. The ${VAR:-} defaults below let interpolation succeed even
    # under db mode (all three env vars will be unset) without hard-failing
    # boot; bootFromDb sees the empty-string fields and logs an "ignored"
    # WARN.
    tunnel:
      controller_url: ${CONTROLLER_URL:-}
      name: ${CONNECTOR_NAME:-}
      environment: prod
      auth_token: ${TUNNEL_AUTH_TOKEN:-}
    mcp_servers:
      - name: example
        transport: http
        endpoint: http://example-mcp.default.svc.cluster.local:7100/mcp
    policy:
      tool_timeout_ms: 5000
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: mcp-connector }
spec:
  replicas: 1
  selector: { matchLabels: { app: mcp-connector } }
  template:
    metadata: { labels: { app: mcp-connector } }
    spec:
      containers:
        - name: connector
          image: us-docker.pkg.dev/<project>/mcp/mcp-connector:0.1.0
          envFrom:
            - secretRef: { name: mcp-connector-token }
          env:
            - { name: CONTROLLER_URL, value: "https://controller.example.com" }
            # CONNECTOR_NAME must match the Name on the controller's Tunnel
            # Security row exactly (case-sensitive). The connector sends it
            # as X-Connector-Name on the WS upgrade and the controller looks
            # the row up by it.
            - { name: CONNECTOR_NAME, value: "prod-customer" }
            # For an OAuth 2.0 row, also add:
            # - { name: OAUTH_TOKEN_URL, value: "https://controller.example.com/oauth2/token" }
            - { name: CONNECTOR_CONFIG, value: "/etc/mcp-connector/config.yaml" }
            # Where the connector persists registrationToken across pod
            # restarts. Without a stable, writable path here, every pod
            # restart re-mints and the controller's dup-name guard 409s.
            - { name: CONNECTOR_STATE_PATH, value: "/var/lib/mcp-connector/.connector-state.json" }
            # INSPECTOR_PORT defaults to 9090 and binds 127.0.0.1 only. Keep it
            # on — any MCP using createWebhookEndpoint depends on the inspector
            # loopback for SDK ↔ connector IPC. Setting INSPECTOR_PORT=0
            # disables both the operator UI AND webhook ingress.
            - { name: INSPECTOR_PORT,   value: "9090" }
          volumeMounts:
            # config.yaml is read-only — sourced from a ConfigMap.
            - { name: config, mountPath: /etc/mcp-connector, readOnly: true }
            # .connector-state.json must be writable AND survive pod restarts
            # — back it with a PVC. ReadWriteOnce is sufficient (replicas: 1).
            - { name: state, mountPath: /var/lib/mcp-connector }
      volumes:
        - name: config
          configMap: { name: mcp-connector-config }
        - name: state
          persistentVolumeClaim: { claimName: mcp-connector-state }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: mcp-connector-state }
spec:
  accessModes: ["ReadWriteOnce"]
  resources: { requests: { storage: 64Mi } }
```

For Secret Manager → Kubernetes secret syncing, use the [Secret Manager CSI
driver](https://cloud.google.com/secret-manager/docs/secret-manager-managed-csi-component).

## Inspector UI

`INSPECTOR_PORT=9090` (the default) is the right value in production. The inspector binds `127.0.0.1` only inside the pod — no Service of any type exposes it — and webhook-receiving MCPs depend on it for SDK ↔ connector IPC. Don't disable it unless no MCP uses `createWebhookEndpoint`.

To view the UI:
```bash
kubectl port-forward deploy/mcp-connector 9090:9090
# open http://localhost:9090/
```

**Do not** create a Service of type `LoadBalancer` or `NodePort` targeting port 9090. The Webhooks panel exposes the bcrypt-protected webhook URL with a copy button — that URL *is* the secret. ClusterIP-only Services for in-cluster debugging are fine.

## Reconnect — orchestrator vs. built-in

The connector auto-reconnects on unexpected WS close by default (`policy.reconnect.enabled: true` in `connector.yaml`). On GKE, two shapes work; pick one.

- **Built-in (default).** Leave `policy.reconnect.enabled: true`. The connector backs off and redials in-process; the pod stays Ready. Right answer when you want the inspector pill to surface tunnel state for in-cluster operators.
- **Kubelet-managed.** Set `policy.reconnect.enabled: false` and add a process exit on terminal disconnect (or a liveness probe against the inspector port that fails when the WS is closed). The kubelet restarts the pod. Right answer when your team uses Kubernetes-native restart semantics and reads pod status, not the inspector, for health.

Don't enable both — the built-in loop will mask pod-level failures from your liveness probes.

## Logs

`stdout` lands in Cloud Logging automatically. Filter:
```
resource.type="k8s_container" resource.labels.container_name="connector"
```
