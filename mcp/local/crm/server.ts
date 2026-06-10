import { createMcpHttpServer } from "@mcp-shim/connector/sdk";
import { getRecent } from "./tools/get-recent.js";
import { issueRefund } from "./tools/issue-refund.js";
import { getCustomer } from "./tools/get-customer.js";

await createMcpHttpServer({
  name: "crm-mcp-server",
  tools: [getCustomer, getRecent, issueRefund],
});
