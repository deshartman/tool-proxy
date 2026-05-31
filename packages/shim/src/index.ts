import "dotenv/config";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { makeAdapter } from "./adapters/index.js";
import { createShimMcpServer } from "./mcp-server.js";
import { TunnelClientTransport } from "./tunnel-client.js";
import { createLocalServerSink } from "./local-server-sink.js";
import type { RegisterFrame } from "@mcp-shim/shared";

async function main() {
  const configPath = process.env.SHIM_CONFIG;
  if (!configPath) throw new Error("SHIM_CONFIG env var is required");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY env var is required");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const mainServerUrl = process.env.MAIN_SERVER_URL ?? "http://localhost:8080/tunnel";
  const authToken = process.env.TUNNEL_AUTH_TOKEN;
  // When LOCAL_SERVER_URL is set the shim ALSO POSTs every event/token to the
  // laptop-side local-server so the on-prem browser tab can render its own
  // shim-side view. Production leaves these unset → no localhost traffic.
  const localServerUrl = process.env.LOCAL_SERVER_URL;
  const localServerToken = process.env.LOCAL_SERVER_TOKEN;

  const config = loadConfig(configPath);

  // POC simplification: one shim hosts one procedure. Real shims would loop here
  // and expose multiple procedures as separate MCP tools.
  if (config.sources.length !== 1) {
    throw new Error("POC supports exactly one source per shim");
  }
  const source = config.sources[0];
  const adapter = makeAdapter(source, config.configDir);

  const openai = new OpenAI({ apiKey });

  const registerFrame: RegisterFrame = {
    type: "register",
    shimId: config.shimId,
    procedures: [{ id: source.id, description: source.description }],
  };
  const transport = new TunnelClientTransport(mainServerUrl, registerFrame, authToken);
  const localSink = createLocalServerSink({
    shimId: config.shimId,
    url: localServerUrl,
    token: localServerToken,
  });

  const emit = (level: "info" | "detail", message: string) => {
    transport.emitEvent(config.shimId, level, message);
    localSink.emit(level, message);
  };
  const emitToken = (queryId: string, seq: number, delta: string, done?: boolean) => {
    transport.emitToken(config.shimId, queryId, seq, delta, done);
    localSink.emitToken(queryId, seq, delta, done);
  };

  const server = createShimMcpServer({
    shimId: config.shimId,
    procedure: { id: source.id, description: source.description, adapter },
    openai,
    model,
    emit,
    emitToken,
  });

  transport.onerror = (e) => console.error(`[${config.shimId}] tunnel error:`, e.message);
  transport.onclose = () => {
    console.error(`[${config.shimId}] tunnel closed`);
    process.exit(1);
  };

  // Document mutation is handled by the laptop-side local-server now —
  // the cloud has no role in it. No `transport.onframe` needed since the
  // doc-change tunnel frame type was removed along with the Fly endpoint.

  await server.connect(transport);
  emit("info", `connected to main server`);
  console.log(`[${config.shimId}] connected to ${mainServerUrl}, exposing procedure: ${source.id}`);
}

main().catch((e) => {
  console.error("shim startup failed:", e);
  process.exit(1);
});
