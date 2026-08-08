import pg from "pg";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { envString, envOptional } from "../env.js";
import { schemaSql } from "./schema.js";
import { MasterKey } from "./master-key.js";
import { seal, open } from "./seal.js";

export interface ControllerRow {
  id: string;
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  tunnelAuthToken: string | null;    // decrypted; null when authMode="oauth2-cc"
  oauthClientId: string | null;
  oauthClientSecret: string | null;  // decrypted
  oauthTokenUrl: string | null;
  registrationToken: string | null;  // decrypted; null before first register-ack
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastConnectedAt: Date | null;
  lastDisconnectReason: string | null;
}

export interface ControllerInput {
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  tunnelAuthToken?: string;        // required when authMode="static-bearer"
  oauthClientId?: string;          // required when authMode="oauth2-cc"
  oauthClientSecret?: string;      // required when authMode="oauth2-cc"
  oauthTokenUrl?: string;          // required when authMode="oauth2-cc"
}

export interface NetworkAccessState {
  enabled: boolean;
}

export interface ApiClientSummary {
  clientId: string;
  name: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export class ConfigStore {
  constructor(private pool: pg.Pool, private schema: string, private key: MasterKey) {}

  static async open(masterKey: MasterKey): Promise<ConfigStore> {
    const url = envString("POSTGRES_URL", "");
    if (!url) throw new Error("POSTGRES_URL is required.");
    const schema = envOptional("POSTGRES_SCHEMA") ?? "mcp_connector";
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    await pool.query(schemaSql(schema));
    // Fingerprint check
    const { rows } = await pool.query(`SELECT key_fingerprint FROM ${schema}.encryption_meta WHERE id=1`);
    if (rows.length === 0) {
      await pool.query(`INSERT INTO ${schema}.encryption_meta (id, key_fingerprint) VALUES (1, $1)`, [masterKey.fingerprint]);
    } else if (rows[0].key_fingerprint !== masterKey.fingerprint) {
      throw new Error("master key does not match the fingerprint recorded on first migration. Restore the original key or wipe the mcp_connector schema and re-add via the inspector.");
    }
    return new ConfigStore(pool, schema, masterKey);
  }

  async getController(): Promise<ControllerRow | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.schema}.controllers LIMIT 1`
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      controllerUrl: r.controller_url,
      connectorName: r.connector_name,
      environment: r.environment,
      authMode: r.auth_mode,
      tunnelAuthToken: r.tunnel_auth_token_ct ? open(r.tunnel_auth_token_ct, this.key.bytes).toString("utf8") : null,
      oauthClientId: r.oauth_client_id,
      oauthClientSecret: r.oauth_client_secret_ct ? open(r.oauth_client_secret_ct, this.key.bytes).toString("utf8") : null,
      oauthTokenUrl: r.oauth_token_url,
      registrationToken: r.registration_token_ct ? open(r.registration_token_ct, this.key.bytes).toString("utf8") : null,
      enabled: r.enabled,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastConnectedAt: r.last_connected_at,
      lastDisconnectReason: r.last_disconnect_reason,
    };
  }

  async upsertController(input: ControllerInput): Promise<ControllerRow> {
    // Validate input
    if (!input.name || !input.controllerUrl || !input.connectorName) {
      throw new Error("name, controllerUrl, and connectorName are required");
    }

    // Check if row exists to determine if this is INSERT or UPDATE.
    // We also read the prior authMode + sealed-secret presence so we can
    // relax the "secret is required" rule when the caller is only updating
    // display fields — the SQL COALESCE at the bottom of this method
    // preserves the existing sealed value when the caller omits the secret.
    // Preservation is only valid when the authMode is UNCHANGED; a switch
    // between static-bearer and oauth2-cc must always supply the new secret.
    const { rows: existing } = await this.pool.query(
      `SELECT id, auth_mode, tunnel_auth_token_ct, oauth_client_secret_ct FROM ${this.schema}.controllers LIMIT 1`
    );
    const priorRow = existing[0] as
      | { id: string; auth_mode: "static-bearer" | "oauth2-cc"; tunnel_auth_token_ct: Buffer | null; oauth_client_secret_ct: Buffer | null }
      | undefined;
    const canPreserveTunnelAuthToken = priorRow?.auth_mode === "static-bearer" && priorRow?.tunnel_auth_token_ct !== null;
    const canPreserveOauthClientSecret = priorRow?.auth_mode === "oauth2-cc" && priorRow?.oauth_client_secret_ct !== null;

    if (input.authMode === "static-bearer" && !input.tunnelAuthToken && !canPreserveTunnelAuthToken) {
      throw new Error("tunnelAuthToken is required when authMode is static-bearer");
    }
    if (input.authMode === "oauth2-cc") {
      if (!input.oauthClientId || !input.oauthTokenUrl) {
        throw new Error("oauthClientId and oauthTokenUrl are required when authMode is oauth2-cc");
      }
      if (!input.oauthClientSecret && !canPreserveOauthClientSecret) {
        throw new Error("oauthClientSecret is required when authMode is oauth2-cc");
      }
    }

    const id = priorRow ? priorRow.id : crypto.randomUUID();
    const now = new Date();

    // Encrypt secrets
    const tunnelAuthTokenCt = input.authMode === "static-bearer" && input.tunnelAuthToken
      ? seal(Buffer.from(input.tunnelAuthToken, "utf8"), this.key.bytes)
      : null;
    const oauthClientSecretCt = input.authMode === "oauth2-cc" && input.oauthClientSecret
      ? seal(Buffer.from(input.oauthClientSecret, "utf8"), this.key.bytes)
      : null;

    await this.pool.query(
      `INSERT INTO ${this.schema}.controllers (
        id, name, controller_url, connector_name, environment, auth_mode,
        tunnel_auth_token_ct, oauth_client_id, oauth_client_secret_ct, oauth_token_url,
        enabled, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11, $11)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        controller_url = EXCLUDED.controller_url,
        connector_name = EXCLUDED.connector_name,
        environment = EXCLUDED.environment,
        auth_mode = EXCLUDED.auth_mode,
        tunnel_auth_token_ct = COALESCE(EXCLUDED.tunnel_auth_token_ct, ${this.schema}.controllers.tunnel_auth_token_ct),
        oauth_client_id = EXCLUDED.oauth_client_id,
        oauth_client_secret_ct = COALESCE(EXCLUDED.oauth_client_secret_ct, ${this.schema}.controllers.oauth_client_secret_ct),
        oauth_token_url = EXCLUDED.oauth_token_url,
        updated_at = EXCLUDED.updated_at`,
      [
        id, input.name, input.controllerUrl, input.connectorName, input.environment, input.authMode,
        tunnelAuthTokenCt, input.oauthClientId ?? null, oauthClientSecretCt, input.oauthTokenUrl ?? null,
        now,
      ]
    );

    return this.getController() as Promise<ControllerRow>;
  }

  async updateRegistrationToken(id: string, token: string): Promise<void> {
    const tokenCt = seal(Buffer.from(token, "utf8"), this.key.bytes);
    await this.pool.query(
      `UPDATE ${this.schema}.controllers SET registration_token_ct = $1, updated_at = now() WHERE id = $2`,
      [tokenCt, id]
    );
  }

  async clearRegistrationToken(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.controllers SET registration_token_ct = NULL, updated_at = now() WHERE id = $1`,
      [id]
    );
  }

  async recordConnect(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.controllers SET last_connected_at = now() WHERE id = $1`,
      [id]
    );
  }

  async recordDisconnect(id: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.controllers SET last_disconnect_reason = $1 WHERE id = $2`,
      [reason, id]
    );
  }

  async deleteController(): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM ${this.schema}.controllers`);
    return (rowCount ?? 0) > 0;
  }

  // ─── Network access ─────────────────────────────────────────────────────
  // Gates ONLY the machine API being reachable non-loopback. There is no
  // admin secret / session concept — the operator UI stays loopback-only
  // unconditionally, forever (see CLAUDE.md "Inspector UI notes").

  async getNetworkAccessState(): Promise<NetworkAccessState> {
    const { rows } = await this.pool.query(
      `SELECT enabled FROM ${this.schema}.network_access WHERE id=1`
    );
    return { enabled: rows[0]?.enabled ?? false };
  }

  // Called once, the first time an operator adds an API client — never
  // reverts automatically, even if every client is later removed.
  async setNetworkAccessEnabled(enabled: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.network_access (id, enabled, updated_at)
       VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [enabled]
    );
  }

  // ─── Machine-API client credentials ────────────────────────────────────

  async mintApiClient(name?: string): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = randomBytes(16).toString("hex");
    const clientSecret = randomBytes(32).toString("base64url");
    const ct = seal(Buffer.from(clientSecret, "utf8"), this.key.bytes);
    await this.pool.query(
      `INSERT INTO ${this.schema}.api_clients (client_id, client_secret_ct, name, created_at)
       VALUES ($1, $2, $3, now())`,
      [clientId, ct, name ?? null]
    );
    return { clientId, clientSecret };
  }

  // Unknown client_id and wrong-secret-for-a-known-client_id both return
  // false — callers must not distinguish the two in their error response
  // (OAuth2 §5.2 invalid_client shape).
  async verifyApiClient(clientId: string, clientSecret: string): Promise<boolean> {
    if (typeof clientId !== "string" || typeof clientSecret !== "string" || clientSecret.length === 0) return false;
    const { rows } = await this.pool.query(
      `SELECT client_secret_ct FROM ${this.schema}.api_clients WHERE client_id=$1 AND revoked_at IS NULL`,
      [clientId]
    );
    const sealedSecret = rows[0]?.client_secret_ct as Buffer | undefined;
    if (!sealedSecret) return false;
    const known = open(sealedSecret, this.key.bytes);
    const supplied = Buffer.from(clientSecret, "utf8");
    if (known.length !== supplied.length) return false;
    return timingSafeEqual(known, supplied);
  }

  async revokeApiClient(clientId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.schema}.api_clients SET revoked_at = now() WHERE client_id=$1 AND revoked_at IS NULL`,
      [clientId]
    );
    return (rowCount ?? 0) > 0;
  }

  async listApiClients(): Promise<ApiClientSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT client_id, name, created_at, revoked_at FROM ${this.schema}.api_clients ORDER BY created_at`
    );
    return rows.map((r) => ({
      clientId: r.client_id,
      name: r.name,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    }));
  }

  async close(): Promise<void> { await this.pool.end(); }
}
