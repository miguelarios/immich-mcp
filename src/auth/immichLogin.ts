/**
 * Turns an Immich email and password into a read-only API key.
 *
 * The password is used for one sign-in and then dropped: it is not stored,
 * logged or returned. The Immich session it opens lives only for this
 * function and is ended before it returns, whether or not the key was made.
 *
 * This is the one place the server changes anything in Immich, and what it
 * changes is the person's own list of API keys, never the photo library.
 */

type Fetch = typeof globalThis.fetch;

export interface ImmichLoginOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: Fetch;
}

export type PasswordSignIn =
  | { ok: true; apiKey: string }
  | { ok: false; kind: "rejected" | "unreachable"; message: string };

const UNREACHABLE: PasswordSignIn = {
  ok: false,
  kind: "unreachable",
  message: "Could not reach Immich. Try again in a moment.",
};

export async function createKeyWithPassword(
  options: ImmichLoginOptions,
  credentials: { email: string; password: string },
  key: { name: string; permissions: string[] },
): Promise<PasswordSignIn> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const call = (method: string, path: string, session?: string, body?: unknown) =>
    fetchImpl(`${options.baseUrl}/api${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect would carry the password or the session somewhere else.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });

  let session: string;
  try {
    const response = await call("POST", "/auth/login", undefined, credentials);
    if (response.status === 400 || response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, kind: "rejected", message: "Incorrect email or password." };
    }
    if (!response.ok) return UNREACHABLE;
    const token = ((await response.json()) as { accessToken?: unknown }).accessToken;
    if (typeof token !== "string" || token === "") return UNREACHABLE;
    session = token;
  } catch {
    return UNREACHABLE;
  }

  try {
    // Signing in again replaces the key from last time instead of adding one more.
    const listed = await call("GET", "/api-keys", session);
    if (listed.ok) {
      const existing = (await listed.json()) as Array<{ id?: unknown; name?: unknown }>;
      for (const old of Array.isArray(existing) ? existing : []) {
        if (old.name === key.name && typeof old.id === "string") {
          const removed = await call("DELETE", `/api-keys/${encodeURIComponent(old.id)}`, session);
          await removed.body?.cancel().catch(() => undefined);
        }
      }
    } else {
      await listed.body?.cancel().catch(() => undefined);
    }

    const created = await call("POST", "/api-keys", session, key);
    if (!created.ok) return UNREACHABLE;
    const secret = ((await created.json()) as { secret?: unknown }).secret;
    if (typeof secret !== "string" || secret === "") return UNREACHABLE;
    return { ok: true, apiKey: secret };
  } catch {
    return UNREACHABLE;
  } finally {
    await call("POST", "/auth/logout", session)
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }
}
