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

export interface KeyRequest {
  /** The new key's name. Keys with exactly this name are replaced. */
  name: string;
  permissions: string[];
  /**
   * Keys whose name starts with `prefix` and that were created before `before`
   * (an ISO instant) are leftovers no sign-in can still be using; they are removed too.
   */
  expired?: { prefix: string; before: string };
}

export type PasswordSignIn =
  | { ok: true; apiKey: string }
  | {
      ok: false;
      kind: "rejected" | "unreachable";
      message: string;
      /** A wrong password, as opposed to input Immich would not even consider. */
      wrongPassword?: boolean;
    };

const UNREACHABLE: PasswordSignIn = {
  ok: false,
  kind: "unreachable",
  message: "Could not reach Immich. Try again in a moment.",
};

export async function createKeyWithPassword(
  options: ImmichLoginOptions,
  credentials: { email: string; password: string },
  key: KeyRequest,
  /** The caller's address, passed on so Immich's own log names them and not this server. */
  clientAddress?: string,
): Promise<PasswordSignIn> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const call = (method: string, path: string, session?: string, body?: unknown) =>
    fetchImpl(`${options.baseUrl}/api${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(clientAddress ? { "x-forwarded-for": clientAddress } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect would carry the password or the session somewhere else.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  const discard = (response: Response) => response.body?.cancel().catch(() => undefined);

  let session: string;
  try {
    const response = await call("POST", "/auth/login", undefined, credentials);
    if (response.status === 401) {
      await discard(response);
      return {
        ok: false,
        kind: "rejected",
        message: "Incorrect email or password.",
        wrongPassword: true,
      };
    }
    if (response.status === 400) {
      // Immich would not take the input at all (an address it does not consider an email).
      await discard(response);
      return { ok: false, kind: "rejected", message: "Immich did not accept that email address." };
    }
    if (!response.ok) return UNREACHABLE;
    const token = ((await response.json()) as { accessToken?: unknown }).accessToken;
    if (typeof token !== "string" || token === "") return UNREACHABLE;
    session = token;
  } catch {
    return UNREACHABLE;
  }

  try {
    // The new key first: if this fails, whatever connection the person had still works.
    const created = await call("POST", "/api-keys", session, {
      name: key.name,
      permissions: key.permissions,
    });
    if (!created.ok) return UNREACHABLE;
    const made = (await created.json()) as {
      secret?: unknown;
      id?: unknown;
      apiKey?: { id?: unknown };
    };
    if (typeof made.secret !== "string" || made.secret === "") return UNREACHABLE;
    // Without the new key's id nothing is deleted: it could not be told apart from the old one.
    const madeId = made.apiKey?.id ?? made.id;

    // Then the ones it replaces. Best effort: a leftover key is untidy, not unsafe.
    try {
      const listed = await call("GET", "/api-keys", session);
      const existing = listed.ok ? ((await listed.json()) as unknown) : await discard(listed);
      for (const old of Array.isArray(existing) ? existing : []) {
        const { id, name, createdAt } = old as {
          id?: unknown;
          name?: unknown;
          createdAt?: unknown;
        };
        if (typeof id !== "string" || typeof name !== "string" || id === madeId) continue;
        const replaced = name === key.name && typeof madeId === "string";
        const leftover =
          key.expired !== undefined &&
          name.startsWith(key.expired.prefix) &&
          typeof createdAt === "string" &&
          createdAt < key.expired.before;
        if (replaced || leftover) {
          await call("DELETE", `/api-keys/${encodeURIComponent(id)}`, session).then(discard);
        }
      }
    } catch {
      // Keep the key that was just made.
    }
    return { ok: true, apiKey: made.secret };
  } catch {
    return UNREACHABLE;
  } finally {
    // The session can do anything the person can, so try twice to close it.
    const logout = () => call("POST", "/auth/logout", session).then(discard);
    await logout().catch(() => logout().catch(() => undefined));
  }
}
