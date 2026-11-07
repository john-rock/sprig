// Runs Fig generators: templates (files/folders), scripts with post-processing,
// and custom async functions.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { executeCommand, type ExecContext } from "./exec.ts";
import { toArray } from "./parser.ts";

export type Generated = {
  suggestion: Fig.Suggestion;
  /** Text kept before the suggestion's name when inserting (directory part, getQueryTerm prefix). */
  keep: string;
};

type CacheEntry = { at: number; result: Promise<Fig.Suggestion[]> };
const cache = new WeakMap<Fig.Generator, Map<string, CacheEntry>>();
/** Results are reused while the user keeps typing the same word. */
const DEFAULT_TTL_MS = 3000;

/** Split the query into the part a generator sees and the part it keeps. */
function queryTerm(query: string, getQueryTerm: Fig.Generator["getQueryTerm"]): { term: string; keep: string } {
  if (typeof getQueryTerm === "string") {
    const at = query.lastIndexOf(getQueryTerm);
    return at < 0 ? { term: query, keep: "" } : { term: query.slice(at + getQueryTerm.length), keep: query.slice(0, at + getQueryTerm.length) };
  }
  if (typeof getQueryTerm === "function") {
    try {
      const term = getQueryTerm(query);
      return { term, keep: query.endsWith(term) ? query.slice(0, query.length - term.length) : "" };
    } catch {
      return { term: query, keep: "" };
    }
  }
  return { term: query, keep: "" };
}

export function templateSuggestions(
  templates: Fig.Template | undefined,
  query: string,
  ctx: ExecContext,
): { items: Generated[]; term: string } {
  const kinds = toArray(templates);
  const slash = query.lastIndexOf("/");
  const keep = slash >= 0 ? query.slice(0, slash + 1) : "";
  const term = query.slice(keep.length);
  if (!kinds.includes("filepaths") && !kinds.includes("folders")) return { items: [], term };

  const foldersOnly = !kinds.includes("filepaths");
  const dir = keep.startsWith("~") ? join(homedir(), keep.slice(1)) : resolve(ctx.cwd, keep || ".");
  const items: Generated[] = [];
  // `code .` / `cd ..` name a directory already. Offer it first, so Enter
  // doesn't swap it for the first dotfile that happens to match.
  if (term === "." || term === "..") {
    items.push({ keep, suggestion: { name: "./", type: "folder", description: "Current directory", priority: 100 } });
    items.push({ keep, suggestion: { name: "../", type: "folder", description: "Parent directory", priority: 100 } });
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { items, term };
  }
  for (const name of entries.slice(0, 5000)) {
    if (name.startsWith(".") && !term.startsWith(".")) continue;
    let isDir = false;
    try {
      isDir = statSync(join(dir, name)).isDirectory();
    } catch {
      continue;
    }
    if (foldersOnly && !isDir) continue;
    items.push({
      keep,
      suggestion: { name: isDir ? `${name}/` : name, type: isDir ? "folder" : "file" },
    });
  }
  return { items, term };
}

export async function runGenerator(
  gen: Fig.Generator,
  query: string,
  tokens: string[],
  ctx: ExecContext,
): Promise<{ items: Generated[]; term: string }> {
  const { term, keep } = queryTerm(query, gen.getQueryTerm);

  if (gen.template && !gen.script && !gen.custom) {
    const t = templateSuggestions(gen.template, query, ctx);
    if (gen.filterTemplateSuggestions) {
      try {
        const filtered = gen.filterTemplateSuggestions(t.items.map((i) => ({ ...i.suggestion, context: { templateType: "filepaths" } }) as Fig.TemplateSuggestion));
        return { term: t.term, items: filtered.map((s) => ({ suggestion: s, keep: t.items[0]?.keep ?? "" })) };
      } catch {
        return t;
      }
    }
    return t;
  }

  // Generators that react to a trigger character (e.g. "/") see a new word after it.
  const triggerKey = typeof gen.trigger === "string" ? query.slice(0, query.lastIndexOf(gen.trigger) + 1) : gen.trigger ? query : "";
  const key = `${ctx.cwd}\0${tokens.slice(0, -1).join("\0")}\0${triggerKey}`;
  let byKey = cache.get(gen);
  if (!byKey) cache.set(gen, (byKey = new Map()));
  const ttl = gen.cache?.ttl ?? DEFAULT_TTL_MS;
  let entry = byKey.get(key);
  if (!entry || Date.now() - entry.at > ttl) {
    entry = { at: Date.now(), result: produce(gen, tokens, term, ctx) };
    byKey.set(key, entry);
    if (byKey.size > 50) byKey.delete(byKey.keys().next().value!);
  }
  const suggestions = await entry.result;
  return { term, items: suggestions.map((s) => ({ suggestion: s, keep })) };
}

async function produce(gen: Fig.Generator, tokens: string[], searchTerm: string, ctx: ExecContext): Promise<Fig.Suggestion[]> {
  const exec = (input: Fig.ExecuteCommandInput) => executeCommand(input, ctx);
  try {
    if (gen.custom) {
      const context = {
        environmentVariables: { ...(process.env as Record<string, string>), ...ctx.env },
        currentWorkingDirectory: ctx.cwd,
        currentProcess: "zsh",
        sshPrefix: "",
        searchTerm,
        isDangerous: false,
      } as unknown as Fig.GeneratorContext;
      return toArray(await gen.custom(tokens, exec, context));
    }
    if (gen.script) {
      const script = typeof gen.script === "function" ? gen.script(tokens) : gen.script;
      const input: Fig.ExecuteCommandInput =
        typeof script === "string"
          ? { command: "bash", args: ["-c", script] }
          : Array.isArray(script)
            ? { command: script[0], args: script.slice(1) }
            : script;
      if (!input?.command) return [];
      const out = await exec({ ...input, timeout: gen.scriptTimeout ?? input.timeout });
      if (gen.postProcess) return toArray(gen.postProcess(out.stdout, tokens));
      if (gen.splitOn !== undefined) {
        return out.stdout
          .split(gen.splitOn)
          .filter((s) => s.trim())
          .map((name) => ({ name }));
      }
    }
  } catch {
    // A broken generator should never break completion.
  }
  return [];
}
