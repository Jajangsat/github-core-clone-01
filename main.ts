// main.ts — the entrypoint the harness drives.
//
// The harness starts a small "env" server beside this process and tells us
// where it lives through MAKEFUN_ENV_URL. Our job is small but strict:
//   1. start the forge server on a kernel-chosen port,
//   2. tell the env which port we bound,
//   3. wait until the env says the trial is over,
//   4. shut down cleanly with exit code 0.
//
// Nothing here talks to the outside world except the env. No git binary,
// no package manager, no model calls — just fetch() and node:http.

import { createApp } from './app.ts';

/** The env origin, without a trailing slash. Empty when unset. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** Longest a single HTTP round-trip may take before we give up on it. */
const ROUND_TRIP_TIMEOUT_MS = 30_000;
/** First pause between retries; each failure doubles it up to the cap. */
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pause after `failures` consecutive failures: 250ms, 500ms, ... capped at 2s. */
function retryPauseMs(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(failures, 8));
}

if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/**
 * Tell the env which port we listen on. The first register wins: a 409
 * means another process already registered, and that is not an error for us.
 * 400/405 mean our request itself is wrong, so we stop. Anything else
 * (network hiccup, 5xx, env still starting) is retried forever.
 */
async function registerWithEnv(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    // A 400/405 means our request itself is wrong: remember it and stop
    // after the try block, instead of throwing through the retry catch.
    let refused: Error | null = null;
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ROUND_TRIP_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        refused = new Error(`register was refused with HTTP ${res.status}: ${await res.text()}`);
      }
      // Any other status: treat it like a transient failure below.
    } catch {
      // Network error or timeout: transient, fall through to the retry.
    }
    if (refused !== null) throw refused;
    await sleep(retryPauseMs(failures));
    failures += 1;
  }
}

/**
 * Ask the env whether the trial is over, forever until it says yes.
 * A slow or failed poll is just another retry — we never exit early.
 */
async function waitForEnvDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(ROUND_TRIP_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is unreachable or slow: keep waiting.
    }
    await sleep(retryPauseMs(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await registerWithEnv(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForEnvDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
