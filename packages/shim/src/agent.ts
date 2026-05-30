import OpenAI from "openai";
import type { SourceAdapter } from "./adapters/index.js";

export interface AgentConfig {
  procedureId: string;
  procedureDescription: string;
  adapter: SourceAdapter;
  openai: OpenAI;
  model: string;
  emit?: (level: "info" | "detail", message: string) => void;
  emitToken?: (seq: number, delta: string, done?: boolean) => void;
}

// The procedure agent. Lives entirely inside the shim process. The cloud-side
// main server only sees the question (in) and the final answer (out).
//
// Doc access: read once at the start of each invocation. Per the plan, this
// guarantees freshness without an extra LLM round-trip. Mid-flight document
// changes are NOT detected in the POC — see filesystem.ts TODO.
export async function runAgent(cfg: AgentConfig, question: string): Promise<string> {
  cfg.emit?.("info", `agent invoked for "${cfg.procedureId}"`);
  const document = await cfg.adapter.fetch();
  cfg.emit?.("detail", `fetched document (${document.length} bytes)`);

  // ────────────────────────────────────────────────────────────────────
  // USER CONTRIBUTION POINT (Learning Mode):
  //
  // Write the system prompt that frames this LLM call as "you are this
  // procedure document." Keep it to 5–10 lines.
  //
  // Things to consider:
  //   - Should the agent answer in terse step-numbered form, or conversationally?
  //   - Should it refuse questions outside the doc's scope, or attempt them?
  //   - Should it cite section headings from the doc in its answer?
  //   - Should it surface the procedure's owner/last-reviewed metadata?
  //
  // The placeholder below is intentionally minimal — replace it with your version.
  // ────────────────────────────────────────────────────────────────────
  const systemPrompt = [
    `You are the procedure agent for "${cfg.procedureId}".`,
    `Description: ${cfg.procedureDescription}`,
    ``,
    `Answer the user's question using ONLY the procedure document below.`,
    `If the document does not address the question, say so.`,
    ``,
    `--- PROCEDURE DOCUMENT ---`,
    document,
    `--- END DOCUMENT ---`,
  ].join("\n");

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: question },
  ];

  // Streaming single-shot. Tokens are pushed to the UI side channel as they
  // arrive; the full text is also returned so the MCP tool result is intact.
  cfg.emit?.("detail", `calling OpenAI (${cfg.model}, streaming)`);
  const stream = await cfg.openai.chat.completions.create({
    model: cfg.model,
    messages,
    stream: true,
  });

  let full = "";
  let seq = 0;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (!delta) continue;
    full += delta;
    cfg.emitToken?.(seq++, delta);
  }
  cfg.emitToken?.(seq, "", true);
  if (!full) return "Agent could not produce an answer.";
  return full;
}

// Self-judging: ask the LLM how confident this procedure is a fit for the
// question. Used by the main server's parallel router. Returns a number 0-100.
// Tight prompt + low max_tokens = ~200-400ms per call vs. 2-8s for ask_procedure.
export async function judgeQuery(cfg: AgentConfig, question: string): Promise<number> {
  cfg.emit?.("detail", `judging query for "${cfg.procedureId}"`);
  const document = await cfg.adapter.fetch();
  const prompt = [
    `You are evaluating whether a single procedure document can answer a user's question.`,
    `Procedure id: ${cfg.procedureId}`,
    `Procedure description: ${cfg.procedureDescription}`,
    ``,
    `Document (truncated to first 2000 chars):`,
    document.slice(0, 2000),
    ``,
    `User question: "${question}"`,
    ``,
    `Reply with ONLY an integer 0-100 — your confidence that THIS document is`,
    `the right one to answer the question. 0 = unrelated, 100 = perfect match.`,
    `No words, no punctuation, just the number.`,
  ].join("\n");

  const res = await cfg.openai.chat.completions.create({
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    // Newer OpenAI models (gpt-5.x reasoning models) require
    // max_completion_tokens instead of max_tokens. Use the new field; older
    // models accept it as an alias.
    max_completion_tokens: 16,
  });
  const raw = res.choices[0]?.message.content?.trim() ?? "";
  const digits = raw.replace(/\D/g, "");
  const n = Number.parseInt(digits, 10);
  const score = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  cfg.emit?.("info", `judge score: ${score} (raw: "${raw}")`);
  return score;
}
