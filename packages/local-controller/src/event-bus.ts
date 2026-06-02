import type { UiEvent } from "./types.js";

// Tiny pub/sub for SSE consumers. Buffers the last N log entries so a fresh
// browser tab can replay state on connect.
class EventBus {
  private listeners = new Set<(e: UiEvent) => void>();
  private logBuffer: Extract<UiEvent, { kind: "log" }>[] = [];
  private static MAX_LOGS = 200;

  publish(e: UiEvent): void {
    if (e.kind === "log") {
      this.logBuffer.push(e);
      if (this.logBuffer.length > EventBus.MAX_LOGS) {
        this.logBuffer.splice(0, this.logBuffer.length - EventBus.MAX_LOGS);
      }
    }
    for (const fn of this.listeners) fn(e);
  }

  subscribe(fn: (e: UiEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recentLogs(): Extract<UiEvent, { kind: "log" }>[] {
    return [...this.logBuffer];
  }
}

export const eventBus = new EventBus();

export function logInfo(msg: string): void {
  eventBus.publish({ kind: "log", ts: Date.now(), level: "info", message: msg });
  console.log(`[ctrl] ${msg}`);
}

export function logDetail(msg: string): void {
  eventBus.publish({ kind: "log", ts: Date.now(), level: "detail", message: msg });
}
