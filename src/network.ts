import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

/**
 * Node connects to a host that has both IPv6 and IPv4 addresses with "happy eyeballs": it starts the next address after 250 ms. When one TCP
 * connect takes longer than that (330 ms from the server to opencode.ai), every attempt is abandoned in turn and `fetch` fails with
 * "fetch failed" / ETIMEDOUT within about 500 ms, although the provider is fine and curl works. With 100 agents this looked like a provider limit.
 * Five seconds leaves the fallback between addresses in place but stops it from cutting off a slow but healthy connect.
 * Called by `runTask`, so every entry point gets it; the same can be set from outside with `node --network-family-autoselection-attempt-timeout=5000`.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5000;

export function allowSlowConnects(): void {
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}
