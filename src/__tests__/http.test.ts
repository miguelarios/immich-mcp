import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../errors.js";
import { loadTransportConfig } from "../mcp/tools.js";

describe("loadTransportConfig", () => {
  it("defaults to stdio", () => {
    expect(loadTransportConfig({})).toEqual({ kind: "stdio" });
  });

  it("reads the HTTP settings with loopback defaults", () => {
    expect(loadTransportConfig({ IMMICH_MCP_TRANSPORT: "HTTP" })).toEqual({
      kind: "http",
      host: "127.0.0.1",
      port: 3000,
      allowedOrigins: [],
    });
    expect(
      loadTransportConfig({
        IMMICH_MCP_TRANSPORT: "http",
        IMMICH_MCP_HTTP_HOST: "0.0.0.0",
        IMMICH_MCP_HTTP_PORT: "8080",
        IMMICH_MCP_HTTP_ALLOWED_ORIGINS: "https://a.example, https://b.example,",
      }),
    ).toEqual({
      kind: "http",
      host: "0.0.0.0",
      port: 8080,
      allowedOrigins: ["https://a.example", "https://b.example"],
    });
  });

  it.each([
    [{ IMMICH_MCP_TRANSPORT: "sse" }],
    [{ IMMICH_MCP_TRANSPORT: "http", IMMICH_MCP_HTTP_PORT: "70000" }],
    [{ IMMICH_MCP_TRANSPORT: "http", IMMICH_MCP_HTTP_PORT: "3000abc" }],
  ])("rejects %o", (env) => {
    expect(() => loadTransportConfig(env)).toThrow(ConfigurationError);
  });
});
