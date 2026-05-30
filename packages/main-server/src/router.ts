import { registry } from "./registry.js";
import { eventBus } from "./event-bus.js";

export interface RoutingDecision {
  shimId: string;
  procedureId: string;
}

export interface RoutingScore {
  shimId: string;
  procedureId: string;
  score: number;
}

// Parallel self-routing: ask every connected shim "can you answer this?"
// concurrently. Each shim runs its own can_answer MCP tool (a small LLM call
// using the customer's key). The main server picks the highest score.
//
// Architectural property preserved: the cloud holds NO LLM credential. Every
// LLM call still happens inside a customer environment.
export async function route(question: string): Promise<{
  decision: RoutingDecision | null;
  scores: RoutingScore[];
}> {
  const shims = registry.list();
  if (shims.length === 0) return { decision: null, scores: [] };

  const candidates = shims.flatMap((s) =>
    s.procedures.map((p) => ({ shim: s, procedureId: p.id }))
  );

  // Run can_answer on every shim concurrently. Treat errors / timeouts as 0.
  const results = await Promise.all(
    candidates.map(async (c): Promise<RoutingScore> => {
      try {
        const r = await c.shim.client.callTool({
          name: "can_answer",
          arguments: { question },
        });
        const text = Array.isArray(r.content)
          ? r.content
              .filter((p: { type: string }) => p.type === "text")
              .map((p: { text: string }) => p.text)
              .join("")
          : "";
        const n = Number.parseInt(text.trim().replace(/\D/g, ""), 10);
        const score = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
        eventBus.publish({
          source: "main",
          panel: "cloud",
          level: "detail",
          message: `route score: ${c.shim.shimId}/${c.procedureId} = ${score}`,
          ts: Date.now(),
        });
        return { shimId: c.shim.shimId, procedureId: c.procedureId, score };
      } catch (e) {
        eventBus.publish({
          source: "main",
          panel: "cloud",
          level: "detail",
          message: `route score: ${c.shim.shimId}/${c.procedureId} = ERROR (${(e as Error).message})`,
          ts: Date.now(),
        });
        return { shimId: c.shim.shimId, procedureId: c.procedureId, score: 0 };
      }
    })
  );

  // Threshold: require a minimum score so unrelated queries get a clear
  // "no shim matched" instead of being forced into an arbitrary one.
  const MIN_SCORE = 20;
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (!top || top.score < MIN_SCORE) {
    return { decision: null, scores: results };
  }
  return {
    decision: { shimId: top.shimId, procedureId: top.procedureId },
    scores: results,
  };
}
