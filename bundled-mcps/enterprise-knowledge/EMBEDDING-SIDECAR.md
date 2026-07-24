# Deploying the Embedding Sidecar (Ollama)

The Enterprise Knowledge bundle requires an Ollama sidecar for generating
embeddings. Text → vector conversion runs in a self-hosted container; no cloud
API keys required, and no chunk text leaves the customer's infrastructure.

This guide covers the deployment shapes for local development, production
Docker Compose, Kubernetes, and Fly.io.

## Overview

- **Image:** `ollama/ollama:latest`
- **Default model:** `nomic-embed-text` (768-dim embeddings)
- **Port:** 11434 (HTTP)
- **Memory:** ~500MB resident (includes model weights)
- **Storage:** Persistent volume for `/root/.ollama` (model cache; ~274MB)

## Local Development

Docker Compose service (already in `deploy/compose/docker-compose.dev.yml`):

```yaml
embedding:
  image: ollama/ollama:latest
  container_name: mcp-shim-embedding
  ports:
    - '${EMBEDDING_HOST_PORT:-11434}:11434'
  volumes:
    - ${EMBEDDING_CACHE_DIR:-./.ollama-cache}:/root/.ollama
  healthcheck:
    test: ['CMD-SHELL', 'ollama list >/dev/null 2>&1 || exit 1']
    interval: 10s
    timeout: 5s
    retries: 12
    start_period: 60s
```

Environment (in `.env`):
```
EK_EMBEDDER=ollama
OLLAMA_URL=http://localhost:11434
# EK_OLLAMA_MODEL=nomic-embed-text
# EMBEDDING_HOST_PORT=11434
# EMBEDDING_CACHE_DIR=./.ollama-cache
```

Start:
```bash
docker compose -f deploy/compose/docker-compose.dev.yml up -d embedding
```

The first boot pulls the model (~1 minute, ~274MB download). The cache directory
(`.ollama-cache/`) persists across container restarts.

## Docker Compose (Production, Single-Host)

Same shape as dev, but with a named volume and restart policy:

```yaml
services:
  connector:
    image: your-registry/mcp-connector:0.1.0
    # ... connector config ...
    environment:
      EK_EMBEDDER: ollama
      OLLAMA_URL: http://embedding:11434

  embedding:
    image: ollama/ollama:latest
    restart: unless-stopped
    volumes:
      - ollama-cache:/root/.ollama
    healthcheck:
      test: ['CMD-SHELL', 'ollama list >/dev/null 2>&1 || exit 1']
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 60s

volumes:
  ollama-cache:
```

## Kubernetes

Deployment + Service + PVC:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: embedding
spec:
  replicas: 1
  selector:
    matchLabels:
      app: embedding
  template:
    metadata:
      labels:
        app: embedding
    spec:
      containers:
        - name: ollama
          image: ollama/ollama:latest
          ports:
            - containerPort: 11434
          volumeMounts:
            - name: cache
              mountPath: /root/.ollama
          livenessProbe:
            exec:
              command: ['sh', '-c', 'ollama list >/dev/null 2>&1']
            initialDelaySeconds: 60
            periodSeconds: 10
      volumes:
        - name: cache
          persistentVolumeClaim:
            claimName: ollama-cache
---
apiVersion: v1
kind: Service
metadata:
  name: embedding
spec:
  selector:
    app: embedding
  ports:
    - port: 11434
      targetPort: 11434
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-cache
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
```

Connector environment:
```yaml
env:
  - name: EK_EMBEDDER
    value: "ollama"
  - name: OLLAMA_URL
    value: "http://embedding.<namespace>.svc.cluster.local:11434"
```

No Ingress is needed — internal cluster access only.

## Fly.io

Separate app from the connector (same pattern the controller team uses):

**`fly.embedding.toml`** (in your deployment repo):
```toml
app = "your-org-mcp-embedding"
primary_region = "iad"

[build]
  image = "ollama/ollama:latest"

[env]
  OLLAMA_HOST = "0.0.0.0:11434"

[http_service]
  internal_port = 11434
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

[[mounts]]
  source = "ollama_cache"
  destination = "/root/.ollama"
```

Create the volume once:
```bash
fly volumes create ollama_cache --region iad --size 5
```

Deploy:
```bash
fly deploy -c fly.embedding.toml
```

Connector environment:
```
EK_EMBEDDER=ollama
OLLAMA_URL=http://your-org-mcp-embedding.internal:11434
```

Approximate cost: ~$5/month (`shared-cpu-2x` + 1GB RAM).

## Air-Gap / Pre-Populated Model

For deployments that cannot reach `registry.ollama.ai` at runtime:

### Option A: Pre-populate the volume

On a build machine with network access:
```bash
docker run --rm \
  -v $(pwd)/ollama-cache:/root/.ollama \
  ollama/ollama:latest \
  ollama pull nomic-embed-text
```

Ship `ollama-cache/` with the deployment; mount it at `/root/.ollama`.

### Option B: Bake into a custom image

```dockerfile
FROM ollama/ollama:latest
RUN ollama pull nomic-embed-text
```

Publish to your internal registry; the bundle's warm-up call becomes a no-op.

## Migration from Local/OpenAI Embedders

If you have existing sources indexed with the removed `local` or `openai`
embedders:

1. Deploy the Ollama sidecar (this doc).
2. Set `EK_EMBEDDER=ollama` and `OLLAMA_URL`.
3. Query sources — you'll get an embedder-mismatch error naming the old provider.
4. Re-index each source:
   ```json
   { "source_id": "src_...", "force": true }
   ```
   The `sources_refresh` tool drops and recreates the pgvector table at the new
dimension (768) and re-embeds all chunks.

## Corporate IT Policies & TLS Inspection

Corporate networks with TLS inspection proxies (e.g., ZScaler, Palo Alto, Blue Coat) intercept HTTPS traffic and present their own certificates. This breaks the Ollama sidecar's ability to pull models from `registry.ollama.ai`.

**Symptom:**
```
ollama warm-up HTTP error 500: Internal Server Error
# Container logs show:
request failed: ...: tls: failed to verify certificate: x509: certificate signed by unknown authority
```

**Solution: Pre-populated model cache (recommended)**

The Ollama sidecar checks for cached models *before* attempting to pull. Pre-populate the cache on a machine with direct internet access, then mount it:

```bash
# On a machine WITHOUT TLS inspection (e.g., personal laptop, cloud VM)
mkdir -p ollama-cache
docker run --rm -v $(pwd)/ollama-cache:/root/.ollama \
  ollama/ollama:latest ollama pull nomic-embed-text

# Copy the cache to your deployment host
rsync -avz ollama-cache/ user@corp-host:/path/to/.ollama-cache/

# Deploy with the cache mounted — warm-up skips the pull entirely
```

**Alternative for IT-managed environments:**

1. **Request registry exemption** — Ask IT to whitelist `registry.ollama.ai` from TLS inspection (rarely granted for external registries).

2. **Internal registry mirror** — Pull the model on an external machine, export the cache, and host it on an internal artifact store (Artifactory, Nexus). Mount via the same volume pattern.

3. **Pre-baked image with model** — Build once on external network, push to internal registry:
   ```dockerfile
   FROM ollama/ollama:latest
   RUN ollama pull nomic-embed-text
   ```
   ```
   docker build -t internal.registry/ollama-embedded:latest .
   docker push internal.registry/ollama-embedded:latest
   ```
   Update your deployment to use `internal.registry/ollama-embedded:latest` instead of `ollama/ollama:latest`.

**Note on warm-up behavior:** As of the EK-LLM-PROVIDER implementation, the warm-up first queries `/api/tags` to check if the model exists locally. If present, it skips `/api/pull` entirely — no network call, no TLS error. The error only occurs when the model is missing from cache AND the network has TLS inspection.

## Troubleshooting

**First query is slow**
- Check that the warm-up succeeded in logs: `ollama warm-up completed` or `ollama model ... already present`
- If not, the first call will trigger the pull; wait ~1 minute.

**Connection refused to embedding service**
- Verify `OLLAMA_URL` matches your deployment shape (localhost for dev,
  service DNS for K8s, internal DNS for Fly.io).
- Check that the healthcheck passes: `docker compose ps` or `kubectl get pods`.

**Out of memory**
- Ollama needs ~500MB for `nomic-embed-text`. Increase container limits.

**SSL/TLS certificate errors pulling model**
See "Corporate IT Policies & TLS Inspection" section above.

## See Also

- Enterprise Knowledge bundle README: `bundled-mcps/enterprise-knowledge/source/README.md`
- LlamaIndex Ollama embeddings: https://docs.llamaindex.ai/en/stable/examples/embeddings/ollama/
