import { z } from "zod";
import { randomBytes } from "node:crypto";
import { createLogger } from "@mcp-shim/connector/sdk";
import type { Tool } from "@mcp-shim/connector/sdk";

// Internal-message dispatcher for notifying the assigned technician about a
// reschedule. Pure mock — there is no real internal-comms backend. The tool
// logs the message and returns a delivery receipt the procedure can quote
// back to the customer.
//
// This is intentionally separate from the customer SMS step (which the
// controller-side procedure composes via the bundled twilio MCP's
// messages_create). One channel per audience.
const log = createLogger("notify-agent");

interface NotificationRecord {
  notificationId: string;
  appointmentId: string;
  message: string;
  deliveredAt: string;
}

function newNotificationId(): string {
  return `ntf_${randomBytes(5).toString("hex")}`;
}

// Always-success contract — this is a mock dispatcher; there's no failure
// path. Schema describes the delivery receipt fields a procedure quotes
// back to the customer.
const OutputSchema = {
  notificationId: z.string().describe("Process-local notification identifier (ntf_<hex>)."),
  appointmentId: z.string().describe("Echoed from input — pin the link in projections."),
  message: z.string().describe("Echoed body; useful when projecting back into a TwiML say."),
  deliveredAt: z.string().describe("Delivery timestamp, ISO 8601 UTC."),
};

export const notifyAgent: Tool = {
  name: "notify_agent",
  register(server) {
    server.registerTool(
      "notify_agent",
      {
        description:
          "Sends an internal-channel notification to the technician assigned to the " +
          "appointment. Pure side-effect; idempotency is not guaranteed (a re-call " +
          "delivers a second notification). Returns { notificationId, appointmentId, " +
          "deliveredAt }.",
        inputSchema: {
          appointmentId: z.string().describe("Appointment the notification is about."),
          message: z
            .string()
            .min(1)
            .describe(
              "Free-text body. Suggested phrasing: 'Reschedule: <customerName> moved " +
                "from <oldStart> to <newStart>'.",
            ),
        },
        outputSchema: OutputSchema,
      },
      async ({ appointmentId, message }) => {
        const record: NotificationRecord = {
          notificationId: newNotificationId(),
          appointmentId,
          message,
          deliveredAt: new Date().toISOString(),
        };
        log.info(
          { notificationId: record.notificationId, appointmentId, message },
          "agent notified",
        );
        return {
          structuredContent: record,
          content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
        };
      },
    );
  },
};
