// Resolves a command name to a Fig completion spec.
//
// Specs are the compiled ES modules from @withfig/autocomplete, loaded from disk
// on first use and kept in memory. Local overrides in ~/.config/sprig/specs
// (and the repo's specs-local/) take precedence.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type SpecModule = { default: Fig.Spec | Fig.Subcommand | ((...args: unknown[]) => unknown) };

const cache = new Map<string, Promise<Fig.Subcommand | undefined>>();
let available: Set<string> | undefined;

/** Directories searched for specs, highest priority first. */
export function specDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.SPRIG_SPECS_DIR) dirs.push(...process.env.SPRIG_SPECS_DIR.split(":"));
  dirs.push(join(homedir(), ".config", "sprig", "specs"));
  // Installed layout: <prefix>/bin/sprig + <prefix>/share/sprig/specs
  dirs.push(join(dirname(process.execPath), "..", "share", "sprig", "specs"));
  // Development layout: run from the repo with `bun src/cli.ts`.
  const repo = join(import.meta.dir, "..", "..");
  dirs.push(join(repo, "specs-local"));
  dirs.push(join(repo, "node_modules", "@withfig", "autocomplete", "build"));
  return dirs.filter((d) => existsSync(d));
}

function listSpecs(): Set<string> {
  if (available) return available;
  available = new Set();
  for (const dir of specDirs()) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".js") && f !== "index.js") available.add(f.slice(0, -3));
    }
    // Scoped package specs, e.g. @withfig/autocomplete-tools.js
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("@")) continue;
      for (const g of readdirSync(join(dir, f))) {
        if (g.endsWith(".js")) available.add(`${f}/${g.slice(0, -3)}`);
      }
    }
  }
  return available;
}

export function hasSpec(name: string): boolean {
  return listSpecs().has(name);
}

export function specCount(): number {
  return listSpecs().size;
}

/** Load a spec by its path within the spec dirs (e.g. "git", "aws/s3"). */
export function loadSpec(name: string): Promise<Fig.Subcommand | undefined> {
  let p = cache.get(name);
  if (!p) {
    p = importSpec(name);
    cache.set(name, p);
  }
  return p;
}

async function importSpec(name: string): Promise<Fig.Subcommand | undefined> {
  if (name.includes("..")) return undefined;
  for (const dir of specDirs()) {
    const file = join(dir, `${name}.js`);
    const indexFile = join(dir, name, "index.js");
    const path = existsSync(file) ? file : existsSync(indexFile) ? indexFile : undefined;
    if (!path) continue;
    try {
      const mod = (await import(path)) as SpecModule;
      const spec = mod.default;
      if (typeof spec === "function") {
        // Versioned specs export a function; we don't resolve versions yet.
        return undefined;
      }
      return spec as Fig.Subcommand;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Map an executable as typed (`/usr/bin/git`, `./node_modules/.bin/tsc`) to a spec name. */
export function commandToSpecName(cmd: string): string | undefined {
  if (hasSpec(cmd)) return cmd;
  const base = cmd.split("/").pop() ?? cmd;
  return hasSpec(base) ? base : undefined;
}
