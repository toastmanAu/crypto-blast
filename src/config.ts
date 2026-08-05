/**
 * Runtime configuration for the Ape Blast client.
 *
 * Values come from Vite env vars (VITE_*) so they can be overridden per
 * deployment without code changes. See `.env.example` / Vite docs.
 */

/**
 * WebSocket URL of the matchmaking/relay server.
 * Default points at a locally-running `npm run server` (port 8787).
 * Override with VITE_MATCHMAKER_URL (use wss:// for HTTPS deployments).
 */
export const MATCHMAKER_URL: string =
  (import.meta.env?.VITE_MATCHMAKER_URL as string | undefined) ?? 'ws://localhost:8787';
