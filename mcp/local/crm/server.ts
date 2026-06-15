import { createMcpHttpServer } from "@mcp-shim/connector/sdk";
import { getRecent } from "./tools/get-recent.js";
import { issueRefund } from "./tools/issue-refund.js";
import { getCustomer } from "./tools/get-customer.js";
import { getAppointment } from "./tools/get-appointment.js";
import { checkAvailability } from "./tools/check-availability.js";
import { updateAppointment } from "./tools/update-appointment.js";
import { notifyAgent } from "./tools/notify-agent.js";

await createMcpHttpServer({
  name: "crm-mcp-server",
  tools: [
    getCustomer,
    getRecent,
    issueRefund,
    getAppointment,
    checkAvailability,
    updateAppointment,
    notifyAgent,
  ],
});
