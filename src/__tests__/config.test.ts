import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { ConfigurationError } from "../errors.js";

const base = { IMMICH_URL: "https://photos.example.test", IMMICH_API_KEY: "k" };

describe("loadConfig", () => {
  it("reads the required values and defaults the rest", () => {
    expect(loadConfig(base)).toEqual({
      baseUrl: "https://photos.example.test",
      apiKey: "k",
      publicUrl: "https://photos.example.test",
      timeZone: "UTC",
      timeoutMs: 30_000,
    });
  });

  it("names every missing required variable", () => {
    expect(() => loadConfig({})).toThrow(
      "Missing required environment: IMMICH_URL, IMMICH_API_KEY",
    );
  });

  it.each([
    ["https://photos.example.test/", "https://photos.example.test"],
    ["https://photos.example.test/api", "https://photos.example.test"],
    ["https://photos.example.test/api/", "https://photos.example.test"],
    ["http://10.0.0.5:2283", "http://10.0.0.5:2283"],
    ["https://example.test/immich/api", "https://example.test/immich"],
  ])("normalizes IMMICH_URL %s", (raw, expected) => {
    expect(loadConfig({ ...base, IMMICH_URL: raw }).baseUrl).toBe(expected);
  });

  it("rejects a non-http URL", () => {
    expect(() => loadConfig({ ...base, IMMICH_URL: "ftp://photos.example.test" })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ ...base, IMMICH_URL: "photos" })).toThrow(ConfigurationError);
  });

  it("uses IMMICH_PUBLIC_URL for links when the API is reached privately", () => {
    const config = loadConfig({
      ...base,
      IMMICH_URL: "http://immich-server:2283",
      IMMICH_PUBLIC_URL: "https://photos.example.test/",
    });
    expect(config.baseUrl).toBe("http://immich-server:2283");
    expect(config.publicUrl).toBe("https://photos.example.test");
  });

  it("validates TZ and the timeout", () => {
    expect(loadConfig({ ...base, TZ: "America/Chicago" }).timeZone).toBe("America/Chicago");
    expect(() => loadConfig({ ...base, TZ: "Mars/Olympus" })).toThrow("TZ must be an IANA");
    expect(() => loadConfig({ ...base, IMMICH_TIMEOUT_MS: "fast" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...base, IMMICH_TIMEOUT_MS: "10" })).toThrow(ConfigurationError);
    expect(loadConfig({ ...base, IMMICH_TIMEOUT_MS: "5000" }).timeoutMs).toBe(5000);
  });
});
