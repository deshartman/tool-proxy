import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ShimProcedure } from "@mcp-shim/shared";
import type { TunnelServerTransport } from "./tunnel-transport.js";

export interface PendingDocOp {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
  kind: "change";
}

export interface RegisteredShim {
  shimId: string;
  procedures: ShimProcedure[];
  client: Client;
  transport: TunnelServerTransport;
  pendingDocOps: Map<string, PendingDocOp>;
}

class Registry {
  private readonly shims = new Map<string, RegisteredShim>();

  register(entry: RegisteredShim): void {
    const existing = this.shims.get(entry.shimId);
    if (existing) existing.client.close().catch(() => {});
    this.shims.set(entry.shimId, entry);
    console.log(
      `[registry] registered ${entry.shimId} with procedures: ${entry.procedures
        .map((p) => p.id)
        .join(", ")}`
    );
  }

  unregister(shimId: string): void {
    const entry = this.shims.get(shimId);
    if (!entry) return;
    this.shims.delete(shimId);
    console.log(`[registry] unregistered ${shimId}`);
  }

  list(): RegisteredShim[] {
    return [...this.shims.values()];
  }

  get(shimId: string): RegisteredShim | undefined {
    return this.shims.get(shimId);
  }
}

export const registry = new Registry();
