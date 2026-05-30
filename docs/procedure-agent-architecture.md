# Procedure Agent Architecture
## Live-Connected Document Agents via Customer-Side MCP Shims

---

## Overview

This document describes an architecture for deploying intelligent procedure agents that represent customer process and procedure documents as first-class AI agents — without copying, indexing, or taking ownership of the customer's documentation.

Each agent *is* the document. When a procedure is updated in Confluence, SharePoint, or any other source, the agent reflects that change automatically on the next invocation. There is no ingestion pipeline, no stale embeddings, and no vendor licence dependency on the document source.

The architecture is portable across AWS, Azure, GCP, and on-premise environments. It requires no inbound firewall rules in the customer environment.

---

## Core Design Principles

**Agent as interface, not retriever.** Traditional RAG treats documents as a passive index — chunks float back to a top-level LLM. In this architecture, each procedure document is represented by its own agent with its own tools. The agent reasons about what it knows and decides how to answer. The document has agency.

**Source of truth stays in place.** Documents are never copied, synced, or indexed into your cloud service. The customer's Confluence page, SharePoint document, or internal wiki is always the canonical source. The agent fetches on demand.

**MCP as the protocol boundary.** The Model Context Protocol (MCP) is used not as a connector library, but as the network boundary protocol between the customer environment and the cloud-side agent service. A thin shim container in the customer environment translates any local source into MCP, and exposes it outbound over an encrypted tunnel.

**Licence independence.** The shim uses the customer's own service account credentials to access their systems locally. No vendor MCP licence is required. Any system accessible via REST, filesystem, or browser is addressable.

---

## Architecture Overview

```
CUSTOMER ENVIRONMENT                        YOUR CLOUD SERVICE
────────────────────────────────            ──────────────────────────────

  Confluence                                Orchestrator Agent
  SharePoint         ┐                         │
  Internal Wiki      │                    ┌────┴──────────────────────┐
  Network file share ├──→  MCP Shim  ──→  │  Procedure Agent Registry │
  Intranet URLs      │    (container)      └────┬──────────────────────┘
  Custom REST APIs   │    outbound only         │
  S3 / Blob storage  ┘    port 443 only    ┌────┴──────────┬────────────────┐
                                           ▼               ▼                ▼
                                      Procedure       Procedure        Procedure
                                      Agent A         Agent B          Agent C
                                      (Incident       (Change          (Onboarding
                                       Response)       Management)      Checklist)
```

The shim is a Docker container you deploy in the customer environment. It has no inbound ports, no cloud-side dependencies, and no persistent storage. Its only job is to translate whatever sources exist locally into MCP, and expose that surface outbound over an encrypted tunnel to your cloud service.

---

## The Customer-Side MCP Shim

### What It Is

A lightweight Python or Node.js container that:

1. Reads a per-customer YAML configuration describing available document sources
2. Instantiates the appropriate source adapter for each one
3. Exposes all sources as MCP tools over a Streamable HTTP endpoint
4. Dials out to your cloud service via an outbound-only encrypted tunnel
5. Advertises its available sources to your cloud-side agent registry on connect

### Source Adapter Registry

The shim uses a config-driven adapter pattern. Adding support for a new source type requires only a new adapter class — no changes to cloud-side agents.

```python
ADAPTERS = {
    "confluence":    ConfluenceAdapter,   # Confluence REST API
    "sharepoint":    SharePointAdapter,   # Microsoft Graph API
    "notion":        NotionAdapter,       # Notion API
    "http":          HttpScrapeAdapter,   # Any URL, rendered or raw
    "filesystem":    FilesystemAdapter,   # Network shares, mounted paths
    "rest":          GenericRestAdapter,  # Any REST endpoint with auth config
    "s3":            S3Adapter,           # AWS S3, GCS, or Azure Blob
}
```

Each adapter implements a single interface:

```python
class SourceAdapter:
    def fetch(self, source_id: str) -> str:
        """Fetch current content of a document."""
        ...

    def list_documents(self) -> list[DocumentRef]:
        """Enumerate available documents from this source."""
        ...
```

### Customer Configuration File

A single YAML file, deployed alongside the container, describes all document sources in the customer environment. This file is the only deployment artefact that changes per customer.

```yaml
# customer-config.yaml
sources:
  - id: incident-response-p1
    type: confluence
    space: OPS
    page_id: "12345"
    description: "P1 Incident Response Procedure"

  - id: change-management
    type: sharepoint
    site: "https://customer.sharepoint.com/sites/IT"
    doc_id: "abc123"
    description: "Change Management Process"

  - id: network-runbook
    type: http
    url: "http://internal-wiki.customer.local/network"
    auth: bearer
    description: "Internal network topology and runbooks"

  - id: db-maintenance
    type: filesystem
    path: "/mnt/shared/runbooks/database.md"
    description: "Database maintenance runbook"

  - id: escalation-matrix
    type: rest
    endpoint: "https://internal-api.customer.local/procedures/escalation"
    auth: api_key
    description: "Escalation contacts and thresholds"
```

When the shim connects to your cloud service, it automatically registers these sources. The orchestrator instantiates a procedure agent for each one without manual configuration.

### Transport Layer

MCP supports two production transports. The shim uses **Streamable HTTP** — a single `/mcp` endpoint accepting both POST and GET requests. Clients POST JSON-RPC messages; the server responds with either a single JSON body or upgrades to an SSE stream for long-running calls.

This transport mode allows the shim to run as an independent service inside the customer network and be tunnelled outbound without opening any inbound ports.

### Tunnel Options

| Option | Best For | Notes |
|---|---|---|
| Cloudflare Tunnel | Most customer environments | Zero inbound ports, outbound only, free tier, runs as a sidecar |
| ngrok | Simpler deployments, dev/test | Easy setup, works behind most firewalls |
| WireGuard | Customers with strict network controls | More setup, fully customer-controlled |
| Tailscale | Multi-site or mesh requirements | Zero-config overlay network |

All options establish outbound connections on port 443 only. No inbound firewall rule changes are required on the customer side. This is typically the single largest deployment friction point in enterprise environments — this design eliminates it entirely.

---

## Cloud-Side Agent Architecture

### Orchestrator Agent

The orchestrator receives requests from users or upstream systems and routes to the appropriate procedure agent. It does not enumerate all agents — it performs **tool retrieval** over the agent registry, pulling only the 3-5 most relevant procedure agents for a given query.

This scales cleanly to large procedure libraries. With 200 registered procedure agents, the orchestrator's reasoning prompt is never overwhelmed.

```
User Request
    │
    ▼
Orchestrator Agent (LangGraph)
    │
    ├── Intent classification
    ├── Tool retrieval over procedure agent index
    ├── Route to relevant procedure agent(s)
    ├── State management across procedure steps
    └── Human-in-the-loop checkpoints (where required)
```

### Procedure Agent

Each procedure agent is a LangGraph agent bound to a specific MCP tool endpoint exposed by the shim. The agent does not hold a copy of the document — it holds a reference to the source via MCP.

```python
ProcedureAgent(
    name        = "Incident Response - P1",
    source      = MCP endpoint + document ID,
    tools       = [fetch_procedure, get_step, validate_step, escalate],
    description = "Owns the P1 incident response procedure from Confluence OPS space"
)
```

When invoked, the agent fetches the current document content via MCP. If the customer updated the Confluence page this morning, the agent reflects that update immediately — no re-ingestion required.

### Procedure Agent Registry

A lightweight catalogue, populated automatically from the shim's advertised sources at connect time. Each entry holds:

- Procedure name and description (used for routing/tool retrieval)
- MCP endpoint reference (which shim, which source ID)
- Metadata (source type, last seen, health status)

Adding a new procedure to a customer environment is a single line in the customer YAML config. The registry picks it up on the next shim heartbeat.

### LLM Portability

All agents route LLM calls through **LiteLLM**, which provides a single OpenAI-compatible interface over:

- **AWS**: Bedrock (Claude, Titan, Llama)
- **Azure**: Azure OpenAI
- **GCP**: Vertex AI (Gemini, Claude)
- **On-prem**: Ollama, vLLM

Agent logic never changes between customer environments. The LLM backend is a configuration switch.

---

## Full System Architecture

```
CUSTOMER ENVIRONMENT
┌──────────────────────────────────────────────────┐
│                                                  │
│  Document Sources         MCP Shim Container     │
│  ─────────────────        ─────────────────────  │
│  Confluence        ──→    Source Adapter         │
│  SharePoint        ──→    Registry               │
│  Internal Wiki     ──→                           │
│  Filesystem        ──→    MCP Streamable HTTP    │
│  Custom REST APIs  ──→    /mcp endpoint          │
│                                │                 │
│                     Outbound tunnel              │
│                     (port 443, encrypted)        │
└─────────────────────────────────│────────────────┘
                                  │
                                  ▼
YOUR CLOUD SERVICE
┌──────────────────────────────────────────────────┐
│                                                  │
│  MCP Gateway / Session Manager                   │
│  (token lifecycle, auth, audit logging)          │
│                 │                                │
│                 ▼                                │
│  Procedure Agent Registry                        │
│  (auto-populated from shim on connect)           │
│                 │                                │
│     ┌───────────┼──────────────┐                 │
│     ▼           ▼              ▼                 │
│  Proc Agent  Proc Agent   Proc Agent  ...        │
│     │            │             │                 │
│     └───────────┬┘─────────────┘                 │
│                 ▼                                │
│  Orchestrator Agent (LangGraph)                  │
│  + LiteLLM (AWS / Azure / GCP)                  │
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## Credential Management

The shim needs read access to customer document sources. These credentials must stay within the customer environment — never transmitted to or stored in your cloud service.

The shim reads credentials at startup from whichever secret store is available in the customer environment:

| Customer Environment | Credential Source |
|---|---|
| AWS | IAM role (ECS/EC2) or Secrets Manager |
| Azure | Managed Identity + Key Vault |
| GCP | Workload Identity + Secret Manager |
| On-premise | HashiCorp Vault or environment variables |

Credentials are scoped to **read-only** on the relevant document sources. This is the posture to negotiate with customer security teams — the shim can only read documents, never write.

---

## Deployment Unit per Customer

What you ship to each customer environment:

| Artefact | Description |
|---|---|
| `mcp-shim` Docker image | The shim container — identical across all customers |
| `customer-config.yaml` | Source definitions — unique per customer |
| `tunnel-config` | Cloudflare/ngrok/WireGuard config pointing to your cloud endpoint |
| Credential references | Pointers to the customer's own secret store |

Deployment time target: under 30 minutes per customer environment, including source configuration and tunnel setup.

---

## Why Not Vendor MCP Servers?

First-party MCP servers (Atlassian, Microsoft, Google) are useful but carry limitations in this context:

- They require the customer to have specific licence tiers to enable MCP access
- Auth tokens are often short-lived, requiring frequent re-authentication in automated flows
- They only cover their own products — obscure internal systems, legacy wikis, and custom APIs have no first-party server
- They route data through the vendor's cloud, which may not satisfy customer data residency requirements

The shim approach sidesteps all of these constraints. It calls the same underlying APIs the vendor servers call, but does so locally using the customer's own credentials, and surfaces the result through your own MCP endpoint under your own control.

First-party vendor MCP servers can still be used as source adapters *inside* the shim where they are available and appropriate — they become implementation options within the adapter registry rather than architectural dependencies.

---

## Observability and Sync

### Freshness

Each procedure agent fetches on demand — there is no cache TTL to manage. Document freshness is guaranteed by definition: the agent always reads the current version of the source.

For high-frequency queries, an optional short-lived cache (60–300 seconds) can be added per-source in the shim config to reduce API calls against the customer's document system. This is a performance knob, not a correctness mechanism.

### Health Monitoring

The shim exposes a `/health` endpoint reporting:

- Which sources are reachable and returning valid content
- Last successful fetch per source
- Tunnel connectivity status

Your cloud-side registry uses this to mark procedure agents as degraded if their source becomes unreachable, and can surface this to the orchestrator so it routes appropriately.

### Procedure Updates

When a source document changes, no action is required. The next invocation of the procedure agent fetches the updated content automatically. For procedures where version awareness matters (e.g. a procedure was updated mid-incident), the shim can optionally return document metadata (last modified, version number) alongside content.

---

## Technology Stack Summary

| Layer | Technology | Rationale |
|---|---|---|
| Shim container | Python (FastAPI + MCP SDK) | Lightweight, fast adapter development, strong MCP SDK support |
| MCP transport | Streamable HTTP | Production-grade, single endpoint, works through tunnel |
| Tunnel | Cloudflare Tunnel | Zero inbound ports, free, runs as sidecar container |
| Orchestration | LangGraph | Graph-based procedure state machines, human-in-the-loop, durable execution |
| LLM abstraction | LiteLLM | Single interface over AWS/Azure/GCP model backends |
| Agent registry | Lightweight Python service | Auto-populated from shim advertisements |
| Agent-to-agent protocol | A2A (watch) | Linux Foundation standard for inter-agent communication; design interfaces to be A2A-compatible |

---

## Future Considerations

**MCP Tunnels (Anthropic, research preview May 2026).** Anthropic announced native MCP tunnel support that opens an outbound-only encrypted connection from customer environments to cloud agents without inbound firewall rules. This aligns exactly with the shim tunnel pattern and may provide a first-party tunnel mechanism in future, potentially simplifying the tunnel configuration step.

**Agent-to-Agent (A2A) Protocol.** Now under Linux Foundation governance with 100+ company supporters, A2A defines how agents from different frameworks communicate directly. Designing procedure agent interfaces to be A2A-compatible from the start allows future interoperability with customer-side agents built on other frameworks, without coupling to any specific orchestration layer.

**Shim-side procedure graph execution.** For highly sensitive environments where procedure content cannot leave the customer network even transiently, a future evolution would push the procedure agent execution into the shim itself — running a local LLM (Ollama/vLLM) within the customer environment and only surfacing results, not content, to the cloud orchestrator.

---

*Document version: 1.0 — May 2026*
