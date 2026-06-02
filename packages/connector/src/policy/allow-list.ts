import type { ConnectorConfig } from "../config.js";

// Decides whether a given `${server}.${tool}` is allowed per the customer's YAML.
//
// Per docs/MCP-TUNNEL.md "Configuration surface":
//   "Default behavior if omitted: deny."
// So `allow_list` absent => everything is allowed=false.
export class AllowList {
  private readonly explicitlyAllowed: Set<string>;
  private readonly hasAllowList: boolean;

  constructor(config: ConnectorConfig) {
    this.hasAllowList = config.allow_list !== undefined;
    this.explicitlyAllowed = new Set(config.allow_list?.tools ?? []);
  }

  isAllowed(server: string, tool: string): boolean {
    if (!this.hasAllowList) return false;
    return this.explicitlyAllowed.has(`${server}.${tool}`);
  }

  // True when the YAML omitted `allow_list` entirely. Worth surfacing as a
  // startup warning since it likely indicates a misconfig: the connector
  // will advertise everything but accept nothing.
  get isEmpty(): boolean {
    return !this.hasAllowList;
  }
}
