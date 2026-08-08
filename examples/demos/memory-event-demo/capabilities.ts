// Advisory-only declaration of which controller actions this bundle calls
// via callControllerApi — see docs/MCP-PROTOCOL.md §"v1.4 — Controller API
// calls (Twilio-bundled only)" "Bundle-facing exposure convention." Never a
// security boundary; the connector-side gate is isAuthorTwilio.
const capabilities = {
  extensions: {
    "memory-event-demo": {
      controllerActions: ["memory.append_event"],
    },
  },
};

export default capabilities;
