import { appendFileSync, mkdirSync } from "node:fs";
import { stateDir } from "../paths.ts";

const FILE = `${stateDir()}/daemon.log`;
const samples: number[] = [];

export function log(msg: string): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

/** Keep the last 500 request latencies; log p50/p95 every 500 requests. */
export function recordLatency(ms: number): void {
  samples.push(ms);
  if (samples.length < 500) return;
  const sorted = [...samples].sort((a, b) => a - b);
  log(`latency p50=${sorted[249].toFixed(1)}ms p95=${sorted[474].toFixed(1)}ms`);
  samples.length = 0;
}
