// lib/rest.mjs — one Discord REST call with Bot auth + 429 backoff. Zero-dep.
// Throws on non-2xx (err.status carries the HTTP status) so callers decide.
import { creds } from "./env.mjs";

const API = "https://discord.com/api/v10";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rest(method, path, { body, reason } = {}) {
  const headers = { Authorization: `Bot ${creds().token}` };
  // Audit-log reason so every role change is attributable in Server Settings.
  if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: payload,
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(Math.ceil((Number(j.retry_after) || 1) * 1000) + 250);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(
        `Discord API ${res.status} ${method} ${path}: ${text}`,
      );
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }
}
