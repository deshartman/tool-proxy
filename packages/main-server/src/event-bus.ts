import { EventEmitter } from "node:events";
import type { UiEvent, UiPayload, UiTokenEvent } from "@mcp-shim/shared";

// In-memory pub/sub between the tunnel layer (events come in) and the SSE
// endpoint (events go out to the browser). Recent events are buffered so a
// newly-connected UI can replay them. Tokens are NOT buffered — they're
// ephemeral per-query.
class EventBus extends EventEmitter {
  private readonly buffer: UiEvent[] = [];
  private readonly bufferLimit = 200;

  publish(event: UiEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.bufferLimit) this.buffer.shift();
    this.emit("payload", event);
  }

  publishToken(token: UiTokenEvent): void {
    this.emit("payload", token);
  }

  recent(): UiEvent[] {
    return [...this.buffer];
  }

  onPayload(listener: (p: UiPayload) => void): void {
    this.on("payload", listener);
  }

  offPayload(listener: (p: UiPayload) => void): void {
    this.off("payload", listener);
  }
}

export const eventBus = new EventBus();
