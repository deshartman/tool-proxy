// Advisory-only declaration of which controller actions this bundle calls
// via callControllerApi — see docs/MCP-PROTOCOL.md §"v1.4 — Controller API
// calls (Twilio-bundled only)" "Bundle-facing exposure convention." Never a
// security boundary; the connector-side gate is isAuthorTwilio.
const capabilities = {
  extensions: {
    "outbound-demo": {
      controllerActions: ["outbound.place_call", "outbound.send_message"],
    },
  },
};

export default capabilities;
