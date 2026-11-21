/**
 * Runs before every test file.
 *
 * The server reads its configuration from the environment, and a developer
 * running it locally usually has IMMICH_URL / IMMICH_API_KEY exported. Tests
 * must never reach a real library, so every IMMICH_* variable is cleared here;
 * a test that needs one sets it with vi.stubEnv or passes an env object.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("IMMICH_")) delete process.env[key];
}
