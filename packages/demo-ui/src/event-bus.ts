import { EventEmitter } from "node:events";
import type { UiEvent, UiPayload, UiTokenEvent } from "@mcp-shim/shared";

// Local event bus for the demo-ui process. Identical pattern to
// packages/main-server/src/event-bus.ts — copied (not imported) so the two
// server packages stay decoupled. Recent UiEvents are buffered for tab replay;
// tokens are ephemeral.
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
