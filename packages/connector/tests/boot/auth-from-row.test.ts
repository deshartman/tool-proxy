import { describe, it, expect } from "vitest";

import { resolveAuthFromRow } from "../../src/boot/auth.js";
import { OAuthClientCredentialsProvider } from "../../src/auth/oauth-provider.js";
import type { ControllerRow } from "../../src/config-store/index.js";

// resolveAuthFromRow maps a decrypted ControllerRow to AuthResolution.
// It is the database-driven counterpart to resolveAuthFromEnv.

describe("resolveAuthFromRow — ControllerRow → AuthResolution", () => {
  it("static-bearer row → returns authToken set, authProvider undefined, status includes len=N", () => {
    const row: ControllerRow = {
      id: "ctrl-123",
      name: "prod-controller",
      controllerUrl: "https://controller.example.com",
      connectorName: "my-connector",
      environment: null,
      authMode: "static-bearer",
      tunnelAuthToken: "ts_abc123xyz_secret",
      oauthClientId: null,
      oauthClientSecret: null,
      oauthTokenUrl: null,
      registrationToken: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastConnectedAt: null,
      lastDisconnectReason: null,
    };

    const result = resolveAuthFromRow(row);

    expect(result.authToken).toBe(row.tunnelAuthToken);
    expect(result.authProvider).toBeUndefined();
    expect(result.status).toBe(`set (len=${row.tunnelAuthToken!.length})`);
  });

  it("OAuth2 row (all three fields present) → returns authToken undefined, authProvider is an OAuthClientCredentialsProvider instance, status includes clientId=", () => {
    const row: ControllerRow = {
      id: "ctrl-456",
      name: "prod-controller-oauth",
      controllerUrl: "https://controller.example.com",
      connectorName: "my-connector",
      environment: null,
      authMode: "oauth2-cc",
      tunnelAuthToken: null,
      oauthClientId: "client_test_abc",
      oauthClientSecret: "super_secret_value",
      oauthTokenUrl: "https://oauth.example.com/token",
      registrationToken: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastConnectedAt: null,
      lastDisconnectReason: null,
    };

    const result = resolveAuthFromRow(row);

    expect(result.authToken).toBeUndefined();
    expect(result.authProvider).toBeInstanceOf(OAuthClientCredentialsProvider);
    expect(result.status).toBe("oauth2 (clientId=client_test_abc)");
  });

  it("static-bearer row missing tunnelAuthToken → throws with actionable message naming the row and the field", () => {
    const row: ControllerRow = {
      id: "ctrl-789",
      name: "bad-static-controller",
      controllerUrl: "https://controller.example.com",
      connectorName: "my-connector",
      environment: null,
      authMode: "static-bearer",
      tunnelAuthToken: null,
      oauthClientId: null,
      oauthClientSecret: null,
      oauthTokenUrl: null,
      registrationToken: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastConnectedAt: null,
      lastDisconnectReason: null,
    };

    expect(() => resolveAuthFromRow(row)).toThrow(/tunnelAuthToken is required.*bad-static-controller.*static-bearer/);
  });

  it("OAuth2 row missing oauthClientId → throws", () => {
    const row: ControllerRow = {
      id: "ctrl-oauth-missing-id",
      name: "bad-oauth-controller",
      controllerUrl: "https://controller.example.com",
      connectorName: "my-connector",
      environment: null,
      authMode: "oauth2-cc",
      tunnelAuthToken: null,
      oauthClientId: null,
      oauthClientSecret: "secret_value",
      oauthTokenUrl: "https://oauth.example.com/token",
      registrationToken: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastConnectedAt: null,
      lastDisconnectReason: null,
    };

    expect(() => resolveAuthFromRow(row)).toThrow(/oauthClientId is required.*bad-oauth-controller.*oauth2-cc/);
  });

  it("OAuth2 row missing oauthClientSecret → throws", () => {
    const row: ControllerRow = {
      id: "ctrl-oauth-missing-secret",
      name: "bad-oauth-controller",
      controllerUrl: "https://controller.example.com",
      connectorName: "my-connector",
      environment: null,
      authMode: "oauth2-cc",
      tunnelAuthToken: null,
      oauthClientId: "client_test",
      oauthClientSecret: null,
      oauthTokenUrl: "https://oauth.example.com/token",
      registrationToken: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastConnectedAt: null,
      lastDisconnectReason: null,
    };

    expect(() => resolveAuthFromRow(row)).toThrow(/oauthClientSecret is required.*bad-oauth-controller.*oauth2-cc/);
  });

  it("OAuth2 row missing oauthTokenUrl → throws", () => {
    const row: ControllerRow = {
      id: "ctrl-oauth-missing-url",
      name: "bad-oauth-controller",
      controllerUrl: "https://controller.example.com",
      connectorName: "my-connector",
      environment: null,
      authMode: "oauth2-cc",
      tunnelAuthToken: null,
      oauthClientId: "client_test",
      oauthClientSecret: "secret_value",
      oauthTokenUrl: null,
      registrationToken: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastConnectedAt: null,
      lastDisconnectReason: null,
    };

    expect(() => resolveAuthFromRow(row)).toThrow(/oauthTokenUrl is required.*bad-oauth-controller.*oauth2-cc/);
  });
});
