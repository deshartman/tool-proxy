import { createMcpHttpServer } from "@mcp-shim/connector/sdk";
import { getRecent } from "./tools/get-recent.js";
import { issueRefund } from "./tools/issue-refund.js";

await createMcpHttpServer({
  name: "orders-mcp-server",
  tools: [getRecent, issueRefund],
});
