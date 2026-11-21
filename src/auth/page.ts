/** The two HTML pages a person sees while connecting: the sign-in form and an error. */

export const REQUIRED_PERMISSIONS = ["asset.read", "asset.view", "person.read", "album.read"];

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // Not "no-referrer": that makes the browser send "Origin: null" with the form, hiding that
  // it came from this page. The page's URL still never leaves this site.
  "referrer-policy": "same-origin",
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  ol { padding-left: 1.25rem; } li { margin: .4rem 0; }
  code { font: .9em ui-monospace, monospace; white-space: nowrap; }
  label { display: block; font-weight: 600; margin: 1.25rem 0 .35rem; }
  input { box-sizing: border-box; width: 100%; padding: .6rem; font: inherit; }
  button { margin-top: 1rem; padding: .6rem 1.2rem; font: inherit; font-weight: 600; cursor: pointer; }
  .warn { border-left: 4px solid #b26a00; padding: .5rem .75rem; margin: 1rem 0; }
  .error { border-left: 4px solid #c62828; padding: .5rem .75rem; margin: 1rem 0; }
  .note { opacity: .75; font-size: .9rem; margin-top: 1.5rem; }
`;

function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, { status, headers: HEADERS });
}

export interface SignInPage {
  /** What the client called itself when it registered. Untrusted text. */
  clientName: string;
  /** Where the browser goes after connecting. */
  redirectUri: string;
  /** The Immich origin people open in a browser. */
  immichUrl: string;
  /** The sealed authorization request, posted back with the key. */
  request: string;
  error?: string;
  status?: number;
}

export function signInPage(view: SignInPage): Response {
  const target = new URL(view.redirectUri);
  const returnsTo =
    target.protocol === "http:" ? "an app on this computer" : escapeHtml(target.host);
  const permissions = REQUIRED_PERMISSIONS.map((p) => `<code>${p}</code>`).join(", ");
  const keysUrl = escapeHtml(`${view.immichUrl}/user-settings?isOpen=api-keys`);
  const error = view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : "";

  return page(
    "Connect your Immich photos",
    `<h1>Connect your Immich photos</h1>
<p>An app that calls itself <strong>${escapeHtml(view.clientName)}</strong> is asking to search and
view your photos. After you connect, you return to ${returnsTo}.</p>
<p class="warn"><strong>Only continue if you started this yourself, just now, in your own app.</strong>
If someone sent you a link to this page, close it: connecting would give them your photos.</p>
${error}
<ol>
<li>Open <a href="${keysUrl}" target="_blank" rel="noopener noreferrer">Immich &rarr; Account Settings &rarr; API Keys</a>
and sign in as usual.</li>
<li>Create a key with only these permissions: ${permissions}.</li>
<li>Paste the key below.</li>
</ol>
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escapeHtml(view.request)}">
<label for="api_key">Immich API key</label>
<input id="api_key" name="api_key" type="password" required autocomplete="off" spellcheck="false">
<button type="submit">Connect</button>
</form>
<p class="note">The key can only read. To disconnect later, delete it in Immich.</p>`,
    view.status ?? 200,
  );
}

export function errorPage(message: string, status = 400): Response {
  return page(
    "Could not connect",
    `<h1>Could not connect</h1><p>${escapeHtml(message)}</p>`,
    status,
  );
}
