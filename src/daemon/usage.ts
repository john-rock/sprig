// Remembers which suggestions the user picks so they rank higher next time.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stateDir } from "../paths.ts";

type Entry = { count: number; last: number };

const FILE = `${stateDir()}/usage.json`;
const MAX_ENTRIES = 5000;
const DAY_MS = 86_400_000;

let entries: Record<string, Entry> = {};
let dirty = false;

try {
  entries = JSON.parse(readFileSync(FILE, "utf8"));
} catch {
  entries = {};
}

const keyOf = (spec: string, insert: string) => `${spec}\0${insert.trim()}`;

export function recordUse(spec: string, insert: string): void {
  const key = keyOf(spec, insert);
  const e = (entries[key] ??= { count: 0, last: 0 });
  e.count++;
  e.last = Date.now();
  dirty = true;
}

/** Priority boost: grows with use, fades over weeks without use. */
export function usageBoost(spec: string, insert: string): number {
  const e = entries[keyOf(spec, insert)];
  if (!e) return 0;
  const ageDays = (Date.now() - e.last) / DAY_MS;
  const recency = ageDays < 1 ? 1 : ageDays < 7 ? 0.7 : ageDays < 30 ? 0.4 : 0.15;
  return Math.min(40, 12 * Math.log2(1 + e.count) * recency);
}

export function flushUsage(): void {
  if (!dirty) return;
  dirty = false;
  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => entries[a].last - entries[b].last);
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[k];
  }
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(entries));
  } catch {
    // Ranking memory is best-effort.
  }
}
