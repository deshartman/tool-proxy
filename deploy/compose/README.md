# Docker Compose

Two compose files ship here, and they are unrelated:

- **`docker-compose.prod.yml`** — single-VM production shape. **One
  container.** The connector's config store is a sealed JSON file on the
  `state` volume, so there is no database service, no DSN, and no password
  secret. Bind the inspector to `127.0.0.1:9090` only. Never expose it to a
  public interface — the Webhooks panel surfaces bcrypt-protected URLs by
  design.
- **`docker-compose.dev.yml`** — a dev-only Postgres for the **`crm` demo's
  mock backend** (`examples/mock-backend/`), on host port 5433 so it doesn't
  collide with another local Postgres. `scripts/start-mock-server.sh` starts
  it for you. It has nothing to do with the connector, which needs no
  database — it used to double as the connector's config store and no longer
  does.

Copy `.env.example` → `.env` — the only thing in it is the image tag. The
connector needs exactly one secret, the master key, mounted as a file at
`/etc/mcp-connector/connector.key`:

```bash
mkdir -p secrets
head -c 32 /dev/urandom > secrets/connector.key && chmod 400 secrets/connector.key
printf 'mcp_servers: []\n' > connector.yaml   # bind-mount SOURCE must exist as a
                                              # FILE first, or Docker creates a
                                              # DIRECTORY and config load fails
docker compose -f docker-compose.prod.yml up -d
```

Everything else — controller URL, connector name, auth posture — is entered in
the inspector's Configure Tunnel modal on first boot and sealed into the state
volume. There are no env vars for them.

## Load-bearing invariants

The compose files hardcode a few properties the connector relies on. Don't
edit them out:

- `127.0.0.1:9090:9090` inspector port binding — inspector is loopback-only.
- The master key mounted read-only. It seals the credentials in
  `config.json`; a volume snapshot without it yields nothing.
- The `state:` named volume. Post-`DB-TO-FILE` this volume **is** the
  connector's identity: `config.json` holds the sealed tunnel bearer and the
  registration token. Destroy it and the operator must re-run Configure
  Tunnel, and the controller will reject the re-register as `name_taken`
  until someone clears the old row. A named volume is also the one mount type
  Docker seeds from the image with ownership intact, which is why compose
  needs no entrypoint `chown` where the cloud targets do.
- No `restart: always` on the connector container (systemd / K8s handle
  supervision; docker's restart policy would mask a fail-fast during
  early boot).

Pinned by [`connector/tests/compose/compose-lint.test.ts`](../../connector/tests/compose/compose-lint.test.ts).

## Network access (opt-in, off by default)

The shipped `127.0.0.1:9090:9090` binding above is unchanged by this
feature and stays the default — don't edit it in this repo's copy. If you
want the inspector reachable from elsewhere on your host's network, change
the port mapping in **your own** compose override (not this file) to
`9090:9090` (all interfaces) or a specific host IP, e.g.:

```yaml
services:
  connector:
    ports:
      - "9090:9090"   # was 127.0.0.1:9090:9090
```

That alone doesn't expose anything unauthenticated: only `POST /oauth/token`
is ever reachable non-loopback, gated by a machine caller's own
`client_id`/`client_secret`, and only once an operator has added at least
one API client from the inspector's loopback session (or one already
exists from a prior boot) — the dashboard itself never becomes reachable
this way. See `docs/NETWORK-ACCESS.md`.

## See also

- Umbrella: [`deploy/README.md`](../README.md).
