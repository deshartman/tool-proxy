# mcp-connector Helm chart

Deploys a single-replica mcp-connector to a Kubernetes cluster.

## Install

```bash
helm install my-connector ./deploy/helm/mcp-connector \
  --set connector.name=prod-us-east-1 \
  --set connector.controllerUrl=https://controller.example.com \
  --set secrets.tunnelAuthToken=ts_your_bearer_from_controller
```

For db mode:

```bash
helm install my-connector ./deploy/helm/mcp-connector \
  --set connector.name=prod-us-east-1 \
  --set connector.controllerUrl=https://controller.example.com \
  --set connector.credsSource=db \
  --set secrets.postgresUrl=postgres://mcp:password@postgres:5432/mcp_connector \
  --set secrets.tunnelAuthToken=ts_your_bearer_from_controller
```

## No Service for the inspector

By design. The inspector binds `127.0.0.1` inside the pod because the
Webhooks panel exposes bcrypt-protected callback URLs — exposing them
via a Service would defeat the entire secret model. Reach the inspector
with `kubectl port-forward`:

```bash
kubectl port-forward svc/my-connector 9090:9090
# open http://localhost:9090/
```

## Chart layout

| File | Purpose |
|------|---------|
| `Chart.yaml` | metadata |
| `values.yaml` | defaults |
| `templates/_helpers.tpl` | naming + labels |
| `templates/secret.yaml` | tunnel auth secret |
| `templates/pvc.yaml` | 64 Mi PVC for registration state |
| `templates/deployment.yaml` | single-replica deployment |

## What this chart does NOT do

- Provision Postgres (needed for db mode). Use a separate chart or a managed service.
- Handle secret rotation. Update via `helm upgrade --set secrets.tunnelAuthToken=...` or an external secret operator.
- Create Service / Ingress / LB. Deliberate — see the inspector note above.

## Reconnect strategy

Configure `policy.reconnect.enabled` in your `connector.yaml` (mounted
separately from the chart today). Two coherent shapes:

- **`true` (in-process, default).** Connector redials in-place, pod stays Ready.
- **`false` (kubelet-managed).** Connector exits non-zero on close, kubelet
  restarts the pod. Useful if your operations team uses pod status as
  ground truth.
