import { randomUUID } from "node:crypto";
import type {
  DocChangeRequestFrame,
  DocChangeResponseFrame,
} from "@mcp-shim/shared";
import { registry } from "./registry.js";

const TIMEOUT_MS = 5_000;

// Demo-only: ask a shim to swap step 1 of its procedure document between two
// predefined variants. Returns the resulting active variant.
export async function changeShimDocument(
  shimId: string,
  sourceId: string,
  variant?: "original" | "alternate"
): Promise<"original" | "alternate"> {
  const shim = registry.get(shimId);
  if (!shim) throw new Error(`shim not connected: ${shimId}`);

  const requestId = randomUUID();
  const frame: DocChangeRequestFrame = {
    type: "doc-change-request",
    requestId,
    sourceId,
    variant,
  };

  return new Promise<"original" | "alternate">((resolve, reject) => {
    const timer = setTimeout(() => {
      shim.pendingDocOps.delete(requestId);
      reject(new Error("doc-change timed out"));
    }, TIMEOUT_MS);
    shim.pendingDocOps.set(requestId, {
      kind: "change",
      resolve: (variantStr: string) => {
        clearTimeout(timer);
        if (variantStr === "original" || variantStr === "alternate") {
          resolve(variantStr);
        } else {
          reject(new Error(`unexpected variant: ${variantStr}`));
        }
      },
      reject: (e: Error) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    shim.transport.sendFrame(frame);
  });
}

// Helper used by tunnel-server when a doc-change-response frame arrives.
export function settleDocChangeResponse(
  shimId: string,
  resp: DocChangeResponseFrame
): void {
  const shim = registry.get(shimId);
  if (!shim) return;
  const op = shim.pendingDocOps.get(resp.requestId);
  if (!op) return;
  shim.pendingDocOps.delete(resp.requestId);
  if (!resp.ok) op.reject(new Error(resp.error ?? "doc-change failed"));
  else op.resolve(resp.variant ?? "");
}
