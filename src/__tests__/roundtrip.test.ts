/**
 * End-to-end wire conformance: a real MCP client talking to the shipped
 * server, on both protocol eras in memory and over real Streamable HTTP.
 * Handler tests cannot catch schema advertisement, argument validation or
 * output-schema enforcement; these do.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { ImmichClient } from "../immich/client.js";
import { PhotoLibrary } from "../library/PhotoLibrary.js";
import { INSTRUCTIONS, createServer } from "../main.js";
import { serveHttp } from "../mcp/tools.js";
import { PHOTO_TOOLS } from "../tools/index.js";
import { BASE, IDS, fakeImmich } from "./fakeImmich.js";

type Era = "legacy" | "modern";

function library() {
  const fake = fakeImmich();
  const client = new ImmichClient({ baseUrl: BASE, apiKey: "k", timeoutMs: 30_000 }, fake.fetch);
  return {
    fake,
    library: new PhotoLibrary(client, { publicUrl: BASE, timeZone: "America/Chicago" }),
  };
}

const handles: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

async function connect(era: Era) {
  const { fake, library: lib } = library();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  handles.push(serveStdio(() => createServer(lib), { transport: serverTransport }));
  const client = new Client(
    { name: "roundtrip-test", version: "0.0.0" },
    { versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" } },
  );
  await client.connect(clientTransport);
  return { client, fake };
}

function schemaKeys(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) schemaKeys(s, out);
  } else if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && value && typeof value === "object") {
        for (const name of Object.keys(value)) out.add(name);
      }
      schemaKeys(value, out);
    }
  }
  return out;
}

describe.each<Era>(["legacy", "modern"])("immich-mcp over the wire (%s era)", (era) => {
  it("negotiates the expected era and sends the instructions", async () => {
    const { client } = await connect(era);
    expect(client.getProtocolEra()).toBe(era);
    if (era === "legacy") expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it("advertises every tool as read-only, titled, in a stable order", async () => {
    const { client } = await connect(era);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(PHOTO_TOOLS.map((t) => t.name));
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      if (tool.name !== "view_photo") expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("names every parameter and output field in camelCase", async () => {
    const { client } = await connect(era);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const keys = [...schemaKeys(tool.inputSchema), ...schemaKeys(tool.outputSchema)];
      expect(
        keys.filter((k) => !/^[a-z][a-zA-Z0-9]*$/.test(k)),
        tool.name,
      ).toEqual([]);
    }
  });

  it("search_photos returns structured results that pass its output schema", async () => {
    const { client, fake } = await connect(era);
    const result = await client.callTool({
      name: "search_photos",
      arguments: {
        query: "sunrise on the beach",
        people: ["ada"],
        taken: { from: "2024" },
        camera: { make: "apple" },
        tags: ["travel"],
        minRating: 4,
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.structuredContent as any;
    expect(content.count).toBe(2);
    expect(content.applied.people).toEqual([{ id: IDS.ada, name: "Ada Lovelace" }]);
    expect(content.applied).toMatchObject({
      cameraMake: "Apple",
      tags: [{ name: "Travel" }],
      minRating: 4,
    });
    expect(JSON.parse((result.content as any)[0].text)).toEqual(content);
    expect(fake.callsTo("POST", "/api/search/smart")[0].body.size).toBe(20);
  });

  it("search_photo_text returns the matched lines", async () => {
    const { client } = await connect(era);
    const result = await client.callTool({
      name: "search_photo_text",
      arguments: { text: "receipt" },
    });
    expect((result.structuredContent as any).photos[0].matchedText).toContain("Receipt #4411");
  });

  it("validates arguments before the handler runs", async () => {
    const { client, fake } = await connect(era);
    const missing = await client
      .callTool({ name: "search_photos", arguments: {} })
      .catch((error) => ({ thrown: error }));
    const tooMany = await client
      .callTool({ name: "search_photo_metadata", arguments: { limit: 1000 } })
      .catch((error) => ({ thrown: error }));
    for (const outcome of [missing, tooMany]) {
      const failed =
        "thrown" in outcome ? outcome.thrown instanceof Error : (outcome as any).isError === true;
      expect(failed).toBe(true);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("reports a domain error as a readable tool error", async () => {
    const { client } = await connect(era);
    const result = await client.callTool({
      name: "search_photo_metadata",
      arguments: { place: { city: "Atlantis" } },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as any)[0].text);
    expect(body).toMatchObject({ error: "NOT_FOUND", retryable: false });
    expect(body.message).toContain("Atlantis");
  });

  it("view_photo returns the image and a caption with the link", async () => {
    const { client } = await connect(era);
    const result = await client.callTool({
      name: "view_photo",
      arguments: { id: IDS.beach, size: "thumbnail" },
    });
    const [image, caption] = result.content as any[];
    expect(image).toEqual({ type: "image", mimeType: "image/webp", data: "/9j/4A==" });
    expect(caption.type).toBe("text");
    expect(caption.text).toContain("IMG_0001.jpg · 2024-06-15T07:12:00 · Playa Example");
    expect(caption.text).toContain(`${BASE}/photos/${IDS.beach}`);
  });

  it("refuses an argument the tool does not have, and a date that is not one", async () => {
    const { client, fake } = await connect(era);
    const before = fake.calls.length;
    // The flat names from 0.3: silently ignoring them would drop the filter.
    const stale = await client
      .callTool({ name: "search_photo_metadata", arguments: { city: "Playa Example" } })
      .catch((error) => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
    expect(stale.isError).toBe(true);
    const badDate = await client
      .callTool({ name: "search_photo_metadata", arguments: { taken: { from: "June 2024" } } })
      .catch((error) => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
    expect(badDate.isError).toBe(true);
    expect(fake.calls).toHaveLength(before);
  });

  it("list_tags and list_cameras pass their output schemas", async () => {
    const { client } = await connect(era);
    const tags = await client.callTool({ name: "list_tags", arguments: { name: "travel" } });
    expect((tags.structuredContent as any).tags.map((tag: any) => tag.name)).toEqual([
      "Travel",
      "Travel/2024",
    ]);
    const cameras = await client.callTool({ name: "list_cameras", arguments: {} });
    expect((cameras.structuredContent as any).makes).toEqual(["Apple", "FUJIFILM"]);
  });

  it("get_photo for an unknown id is NOT_FOUND", async () => {
    const { client } = await connect(era);
    const result = await client.callTool({ name: "get_photo", arguments: { id: IDS.missing } });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain("NOT_FOUND");
  });
});

describe("immich-mcp over Streamable HTTP", () => {
  it("serves the shipped server, a health check, and rejects foreign origins", async () => {
    const { library: lib } = library();
    const http = await serveHttp(() => createServer(lib), {
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [],
    });
    handles.push(http);

    const health = await fetch(new URL("/healthz", http.url));
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    expect((await fetch(new URL("/nope", http.url))).status).toBe(404);

    const forbidden = await fetch(http.url, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(forbidden.status).toBe(403);

    for (const mode of ["legacy", { pin: "2026-07-28" }] as const) {
      const client = new Client(
        { name: "http-test", version: "0.0.0" },
        { versionNegotiation: { mode } },
      );
      await client.connect(new StreamableHTTPClientTransport(http.url));
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(PHOTO_TOOLS.length);
      const result = await client.callTool({
        name: "list_albums",
        arguments: { name: "trip" },
      });
      expect((result.structuredContent as any).albums[0].name).toBe("Beach Trip 2024");
      await client.close();
    }
  });
});

describe("input schemas", () => {
  it("refuse unknown arguments at every level, on every tool", () => {
    const open: string[] = [];
    const walk = (schema: any, path: string) => {
      if (schema?.type !== "object") return;
      if (schema.additionalProperties !== false) open.push(path);
      for (const [name, child] of Object.entries(schema.properties ?? {})) {
        walk(child, `${path}.${name}`);
      }
    };
    for (const tool of PHOTO_TOOLS) walk(tool.inputSchema, tool.name);
    expect(open).toEqual([]);
  });
});
