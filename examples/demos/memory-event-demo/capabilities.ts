// Advisory-only declaration of which controller actions this bundle calls
// via callControllerApi — see docs/MCP-PROTOCOL.md §"v1.4 — Controller API
// calls (Twilio-bundled only)" "Bundle-facing exposure convention." Never a
// security boundary; the connector-side gate is isAuthorTwilio.
const capabilities = {
  extensions: {
    "memory-event-demo": {
      // Three actions, because injection is a resolve-then-write flow: resolve
      // the customer to an opaque identityId, then write the fact against it.
      controllerActions: ["identity.list", "memory.inject_context"],
    },
  },
};

export default capabilities;
