import { createMcpHttpServer } from "@mcp-shim/connector/sdk";
import { messagesCreate } from "./tools/messages_create.js";
import { messagesFetch } from "./tools/messages_fetch.js";
import { messagingServicesFetch } from "./tools/messaging_services_fetch.js";
import { contentTemplatesFetch } from "./tools/content_templates_fetch.js";
import { callsCreate } from "./tools/calls_create.js";
import { callsFetch } from "./tools/calls_fetch.js";
import { verifySend } from "./tools/verify_send.js";
import { verifyCheck } from "./tools/verify_check.js";
import { verifyServicesFetch } from "./tools/verify_services_fetch.js";
import { lookupsFetch } from "./tools/lookups_fetch.js";
import { emailSend } from "./tools/email_send.js";
import { emailFetch } from "./tools/email_fetch.js";
import { emailSearch } from "./tools/email_search.js";
import { emailTemplatesFetch } from "./tools/email_templates_fetch.js";

await createMcpHttpServer({
  name: "apis",
  tools: [
    messagesCreate,
    messagesFetch,
    messagingServicesFetch,
    contentTemplatesFetch,
    callsCreate,
    callsFetch,
    verifySend,
    verifyCheck,
    verifyServicesFetch,
    lookupsFetch,
    emailSend,
    emailFetch,
    emailSearch,
    emailTemplatesFetch,
  ],
});
