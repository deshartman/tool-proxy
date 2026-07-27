import { describe, it, expect } from "vitest";
import { runChecks } from "../../src/doctor.js";

describe("doctor POSTGRES_URL redaction", () => {
  it("redacts password when skipNetwork is true", async () => {
    const env = {
      CONNECTOR_CREDS_SOURCE: "db",
      POSTGRES_URL: "postgres://user:secretpassword@localhost:5432/mcp_connector",
      CONNECTOR_KEY_FILE: "/tmp/fake.key",
    };
    const results = await runChecks(env, { skipNetwork: true });
    const pgCheck = results.find((c) => c.name === "postgres-url");
    expect(pgCheck).toBeDefined();
    expect(pgCheck?.message).toContain("***");
    expect(pgCheck?.message).not.toContain("secretpassword");
  });
});
