import { createMcpHttpServer } from "@mcp-shim/connector/sdk";
import { sendSms } from "./tools/send-sms.js";
import { lookupPhoneNumber } from "./tools/lookup-phone-number.js";
import { listRecent } from "./tools/list-recent.js";

await createMcpHttpServer({
  name: "twilio-mcp-server",
  tools: [sendSms, lookupPhoneNumber, listRecent],
});
