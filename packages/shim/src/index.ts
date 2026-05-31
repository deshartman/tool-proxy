import "dotenv/config";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { makeAdapter } from "./adapters/index.js";
import { createShimMcpServer } from "./mcp-server.js";
import { TunnelClientTransport } from "./tunnel-client.js";
import { createDemoUiSink } from "./demo-ui-sink.js";
import type {
  DocChangeResponseFrame,
  RegisterFrame,
  TunnelFrame,
} from "@mcp-shim/shared";

async function main() {
  const configPath = process.env.SHIM_CONFIG;
  if (!configPath) throw new Error("SHIM_CONFIG env var is required");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY env var is required");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const mainServerUrl = process.env.MAIN_SERVER_URL ?? "http://localhost:8080/tunnel";
  const authToken = process.env.TUNNEL_AUTH_TOKEN;
  // DEMO-ONLY: when DEMO_UI_URL is set the shim ALSO POSTs every event/token
  // to a local demo-ui process so the laptop browser tab can render its own
  // shim-side view. Production leaves these unset → no localhost traffic.
  const demoUiUrl = process.env.DEMO_UI_URL;
  const demoUiToken = process.env.DEMO_UI_TOKEN;

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
  const demoSink = createDemoUiSink({
    shimId: config.shimId,
    url: demoUiUrl,
    token: demoUiToken,
  });

  const emit = (level: "info" | "detail", message: string) => {
    transport.emitEvent(config.shimId, level, message);
    demoSink.emit(level, message);
  };
  const emitToken = (queryId: string, seq: number, delta: string, done?: boolean) => {
    transport.emitToken(config.shimId, queryId, seq, delta, done);
    demoSink.emitToken(queryId, seq, delta, done);
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

  // Demo-only: handle doc-change requests pushed down the tunnel. The shim
  // toggles step 1 of its document between two predefined variants from
  // the YAML config and replies with the resulting active variant.
  transport.onframe = (frame: TunnelFrame) => {
    if (frame.type !== "doc-change-request" || frame.sourceId !== source.id) return;
    const apply = adapter.applyVariant;
    if (!apply) {
      const resp: DocChangeResponseFrame = {
        type: "doc-change-response",
        requestId: frame.requestId,
        ok: false,
        error: "adapter does not support variants",
      };
      transport.sendFrame(resp);
      return;
    }
    apply
      .call(adapter, frame.variant)
      .then((active) => {
        emit("info", `document switched to variant: ${active}`);
        const resp: DocChangeResponseFrame = {
          type: "doc-change-response",
          requestId: frame.requestId,
          ok: true,
          variant: active,
        };
        transport.sendFrame(resp);
      })
      .catch((e: unknown) => {
        const resp: DocChangeResponseFrame = {
          type: "doc-change-response",
          requestId: frame.requestId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
        transport.sendFrame(resp);
      });
  };

  await server.connect(transport);
  emit("info", `connected to main server`);
  console.log(`[${config.shimId}] connected to ${mainServerUrl}, exposing procedure: ${source.id}`);
}

main().catch((e) => {
  console.error("shim startup failed:", e);
  process.exit(1);
});
