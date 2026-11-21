import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for everything the OAuth server hands out and later
 * gets back: client ids, the sign-in form's request, and the tokens.
 *
 * Each purpose gets its own key (HKDF over the server secret), so a value
 * sealed as one thing never opens as another: a refresh token is not an
 * access token.
 */
export class Sealer {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly secret: string) {}

  private key(purpose: string): Buffer {
    let key = this.keys.get(purpose);
    if (!key) {
      key = Buffer.from(hkdfSync("sha256", this.secret, "immich-mcp", purpose, 32));
      this.keys.set(purpose, key);
    }
    return key;
  }

  /** AES-256-GCM over the JSON of `payload`: base64url(iv | tag | ciphertext). */
  seal(purpose: string, payload: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(purpose), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  /** The payload, or `undefined` for anything not sealed here for this purpose. */
  open<T>(purpose: string, sealed: string): T | undefined {
    try {
      const raw = Buffer.from(sealed, "base64url");
      if (raw.length < 29) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key(purpose), raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return JSON.parse(text.toString("utf8")) as T;
    } catch {
      return undefined;
    }
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
