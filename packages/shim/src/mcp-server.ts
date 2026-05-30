import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SourceAdapter } from "./adapters/index.js";
import { judgeQuery, runAgent } from "./agent.js";
import OpenAI from "openai";

export interface ProcedureBinding {
  id: string;
  description: string;
  adapter: SourceAdapter;
}

export function createShimMcpServer(opts: {
  shimId: string;
  procedure: ProcedureBinding;
  openai: OpenAI;
  model: string;
  emit?: (level: "info" | "detail", message: string) => void;
  emitToken?: (queryId: string, seq: number, delta: string, done?: boolean) => void;
}): Server {
  const server = new Server(
    { name: `mcp-shim:${opts.shimId}`, version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // The agent is hidden behind two MCP tools. The cloud-side main server
  // sees only these tools — never the underlying document or the LLM.
  //   ask_procedure: produce an answer (streams tokens to UI)
  //   can_answer:    self-judge confidence 0-100 for routing
  const ASK = "ask_procedure";
  const JUDGE = "can_answer";

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: ASK,
        description: opts.procedure.description,
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The user's question about this procedure.",
            },
            queryId: {
              type: "string",
              description: "Demo-only correlation id for streaming the answer to the UI.",
            },
          },
          required: ["question"],
        },
      },
      {
        name: JUDGE,
        description:
          "Self-routing: score 0-100 for how well this procedure can answer the question.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string" },
          },
          required: ["question"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as {
      question?: unknown;
      queryId?: unknown;
    };
    const question = typeof args.question === "string" ? args.question : "";
    if (!question) throw new Error("Missing 'question' argument");

    if (req.params.name === JUDGE) {
      const score = await judgeQuery(
        {
          procedureId: opts.procedure.id,
          procedureDescription: opts.procedure.description,
          adapter: opts.procedure.adapter,
          openai: opts.openai,
          model: opts.model,
          emit: opts.emit,
        },
        question
      );
      return { content: [{ type: "text", text: String(score) }] };
    }

    if (req.params.name !== ASK) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }

    const queryId = typeof args.queryId === "string" ? args.queryId : "";
    opts.emit?.("info", `ask_procedure called`);
    const answer = await runAgent(
      {
        procedureId: opts.procedure.id,
        procedureDescription: opts.procedure.description,
        adapter: opts.procedure.adapter,
        openai: opts.openai,
        model: opts.model,
        emit: opts.emit,
        emitToken: queryId
          ? (seq: number, delta: string, done?: boolean) =>
              opts.emitToken?.(queryId, seq, delta, done)
          : undefined,
      },
      question
    );
    opts.emit?.("info", `answer produced (${answer.length} chars)`);

    return {
      content: [{ type: "text", text: answer }],
    };
  });

  return server;
}

export async function connectShimServer(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}
