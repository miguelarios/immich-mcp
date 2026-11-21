import {
  type CallToolResult,
  type JsonSchemaType,
  type McpServer,
  type ServerContext,
  type ToolAnnotations,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
/**
 * The MCP facade the tools are written against: a declarative tool shape,
 * registration, and result helpers. Modelled on @miguelarios/pim-core/mcp so
 * the servers read alike; the confirmation gate is left out because every
 * tool here is read-only.
 */
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";
import { toImmichError } from "../errors.js";

export type { CallToolResult, ServerContext, ToolAnnotations };

/** Read-only, idempotent, and reaching an external system: true of every tool here. */
export const READ_ONLY: ToolDef<unknown>["annotations"] = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * A declarative tool definition. Tools stay an inspectable array rather than
 * a pile of `registerTool` calls so tests can assert over them.
 */
// `Args` defaults to `any` so a heterogeneous `ToolDef<Service>[]` can hold handlers that
// each declare their own argument type. The SDK validates arguments against `inputSchema`
// before the handler runs, so the declared type is an authoring aid, not the safety boundary.
export interface ToolDef<Service, Args = any> {
  /** Wire name, `[A-Za-z0-9_.-]{1,128}`. */
  name: string;
  title: string;
  description: string;
  annotations: Required<
    Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
  >;
  inputSchema: JsonSchemaType;
  /** Valibot schema for `structuredContent`; the SDK validates results against it. */
  outputSchema?: GenericSchema;
  handler: (args: Args, service: Service, ctx: ServerContext) => Promise<CallToolResult>;
}

export function registerTools<Service>(
  server: McpServer,
  defs: ReadonlyArray<ToolDef<Service>>,
  service: Service,
): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        annotations: def.annotations,
        inputSchema: fromJsonSchema(def.inputSchema),
        ...(def.outputSchema ? { outputSchema: toStandardJsonSchema(def.outputSchema) } : {}),
      },
      (args: any, ctx: ServerContext) => def.handler(args, service, ctx),
    );
  }
}

const EMPTY_CTX = {} as ServerContext;

/**
 * Invokes one tool's handler by name, bypassing the transport. For tests and
 * embedding; argument validation lives in the SDK's `tools/call` path, so the
 * caller is responsible for well-formed `args`.
 */
export function dispatchTool<Service>(
  defs: ReadonlyArray<ToolDef<Service>>,
  name: string,
  args: Record<string, unknown>,
  service: Service,
  ctx: ServerContext = EMPTY_CTX,
): Promise<CallToolResult> {
  const tool = defs.find((def) => def.name === name);
  if (!tool) return Promise.resolve(fail("UNKNOWN_TOOL", `Unknown tool: ${name}`));
  return tool.handler(args, service, ctx);
}

/**
 * A successful result carrying machine-readable data. The spec requires the
 * serialized JSON in a text block too, for clients that ignore
 * `structuredContent`.
 */
export function structured<T>(payload: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as CallToolResult["structuredContent"],
  };
}

/** A tool execution error the model can read and correct itself from. */
export function fail(code: string, message: string, retryable = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message, retryable }) }],
    isError: true,
  };
}

export function toolError(err: unknown): CallToolResult {
  const error = toImmichError(err);
  return fail(error.code, error.message, error.retryable);
}

/** Cache hint for `tools/list`: the list is static and the same for every caller. */
export const TOOL_LIST_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" } as const;

export {
  type HttpHandlerOptions,
  type HttpServerHandle,
  type McpHttpHandler,
  type TransportConfig,
  HEALTH_PATH,
  MCP_HTTP_PATH,
  createHttpHandler,
  loadTransportConfig,
  serve,
  serveHttp,
} from "./http.js";
