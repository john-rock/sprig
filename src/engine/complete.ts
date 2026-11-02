// Entry point of the engine: text left of the cursor in, ranked suggestions out.

import { tokenize } from "./tokenizer.ts";
import { parseCommand, toArray, type CompletionContext } from "./parser.ts";
import { runGenerator, templateSuggestions, type Generated } from "./generators.ts";
import { rank } from "./rank.ts";
import type { ExecContext } from "./exec.ts";

export type Item = {
  /** Text shown in the dropdown. */
  display: string;
  /** Replacement for the whole word under the cursor, already shell-escaped. */
  insert: string;
  description: string;
  kind: string;
};

export type Result = {
  /** Number of characters left of the cursor that `insert` replaces. */
  replaceLen: number;
  items: Item[];
  /** Root spec that produced the items, e.g. "git". */
  specName?: string;
};

export type Completion = Result & {
  /** Present when slow generators are still running; resolves to the full result. */
  more?: Promise<Result>;
};

type Candidate = {
  suggestion: Fig.Suggestion;
  /** Typed text the suggestion is matched against. */
  term: string;
  /** Text kept in front of the suggestion's name. */
  keep: string;
  kind: string;
};

const MAX_ITEMS = 50;
/** How long to wait for generators before answering with what we have. */
const FIRST_PAINT_MS = 40;

export type UsageBoost = (specName: string, insert: string) => number;

export async function complete(
  lbuffer: string,
  ctx: ExecContext,
  boost?: UsageBoost,
  aliases?: Record<string, string>,
): Promise<Completion> {
  const { tokens } = tokenize(expandAlias(lbuffer, aliases));
  const token = tokens[tokens.length - 1];
  const replaceLen = Array.from(token?.raw ?? "").length;
  const empty: Completion = { replaceLen, items: [] };
  if (!token) return empty;

  const cc = await parseCommand(tokens, ctx);
  if (!cc) return empty;

  const staticCands = staticCandidates(cc, ctx);
  const pending = generatorCandidates(cc, ctx);
  const finish = (cands: Candidate[]): Result => ({ replaceLen, items: toItems(cc, cands, boost), specName: cc.specName });

  if (!pending.length) return finish(staticCands);

  const all = Promise.all(pending).then((lists) => [...staticCands, ...lists.flat()]);
  const quick = await Promise.race([all, Bun.sleep(FIRST_PAINT_MS).then(() => undefined)]);
  if (quick) return finish(quick);
  return { ...finish(staticCands), more: all.then(finish) };
}

/** Expand a shell alias in command position (`g co` → `git co`), one level deep. */
function expandAlias(lbuffer: string, aliases?: Record<string, string>): string {
  if (!aliases) return lbuffer;
  const { tokens } = tokenize(lbuffer);
  const cmd = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value));
  // Only once the alias word is complete; otherwise the user is still typing it.
  if (!cmd || cmd === tokens[tokens.length - 1]) return lbuffer;
  const value = aliases[cmd.value];
  if (!value || value.split(/\s/)[0] === cmd.value) return lbuffer;
  const chars = Array.from(lbuffer);
  return chars.slice(0, cmd.start).join("") + value + chars.slice(cmd.start + Array.from(cmd.raw).length).join("");
}

function staticCandidates(cc: CompletionContext, ctx: ExecContext): Candidate[] {
  const out: Candidate[] = [];
  const q = cc.query;
  const addArg = (arg: Fig.Arg | undefined) => {
    if (!arg) return;
    for (const s of arg.suggestions ?? []) {
      out.push({ suggestion: typeof s === "string" ? { name: s } : s, term: q, keep: "", kind: "arg" });
    }
    if (arg.template) {
      const t = templateSuggestions(arg.template, q, ctx);
      for (const g of t.items) out.push({ ...g, term: t.term, kind: g.suggestion.type ?? "file" });
    }
  };
  const addSubcommands = () => {
    for (const s of cc.subcommand.subcommands ?? []) out.push({ suggestion: s, term: q, keep: "", kind: "subcommand" });
    for (const s of cc.subcommand.additionalSuggestions ?? []) {
      out.push({ suggestion: typeof s === "string" ? { name: s } : s, term: q, keep: "", kind: "special" });
    }
  };
  const addOptions = () => {
    const passedNames = new Set([...cc.passedOptions].flatMap((o) => toArray(o.name)));
    for (const o of cc.options) {
      if (cc.passedOptions.has(o) && !o.isRepeatable) continue;
      if (o.exclusiveOn?.some((n) => passedNames.has(n))) continue;
      out.push({ suggestion: o, term: q, keep: "", kind: "option" });
    }
  };

  switch (cc.kind) {
    case "options":
      addOptions();
      break;
    case "option-value":
      addArg(cc.arg);
      if (cc.alsoArgs) {
        if (cc.alsoArgs.offerSubcommands) addSubcommands();
        addArg(cc.alsoArgs.arg);
      }
      break;
    case "args":
      if (cc.offerSubcommands) addSubcommands();
      addArg(cc.arg);
      if (!out.length && q === "" && !toArray(cc.subcommand.args).length) addOptions();
      break;
  }
  return out;
}

function generatorCandidates(cc: CompletionContext, ctx: ExecContext): Promise<Candidate[]>[] {
  const args = cc.kind === "options" ? [] : [cc.arg, cc.alsoArgs?.arg];
  const out: Promise<Candidate[]>[] = [];
  for (const arg of args) {
    for (const gen of toArray(arg?.generators)) {
      out.push(
        runGenerator(gen, cc.query, cc.tokens, ctx).then((r) =>
          r.items.map((g: Generated) => ({ ...g, term: r.term, kind: g.suggestion.type ?? "arg" })),
        ),
      );
    }
  }
  return out;
}

function toItems(cc: CompletionContext, cands: Candidate[], boost?: UsageBoost): Item[] {
  const visible = cands.filter((c) => !c.suggestion.hidden && toArray(c.suggestion.name).some((n) => n?.trim()));
  const ranked = rank(
    visible,
    (c) => toArray(c.suggestion.name),
    (c) => c.term,
    (c) => (c.suggestion.priority ?? 50) - (c.suggestion.deprecated ? 20 : 0),
    boost ? (c) => boost(cc.specName, insertValue(c)) : undefined,
  );

  const seen = new Set<string>();
  const items: Item[] = [];
  for (const c of ranked) {
    const value = insertValue(c);
    if (seen.has(value)) continue;
    seen.add(value);
    items.push({
      display: displayName(c),
      insert: escapeForShell(cc.queryPrefix + c.keep + value, cc) + (needsSpace(c, value) ? " " : ""),
      description: firstLine(c.suggestion.description),
      kind: c.kind,
    });
    if (items.length >= MAX_ITEMS) break;
  }

  // Nothing to add when the word is already complete and unambiguous.
  if (items.length === 1 && insertValue(ranked[0]) === ranked[0].term) return [];
  return items;
}

function insertValue(c: Candidate): string {
  const s = c.suggestion;
  if (s.insertValue) return s.insertValue.replace("{cursor}", "");
  const names = toArray(s.name);
  // Insert the alias matching what was typed (`-v` vs `--verbose`).
  return names.find((n) => n.startsWith(c.term)) ?? names[0];
}

function displayName(c: Candidate): string {
  const s = c.suggestion;
  if (s.displayName) return s.displayName;
  const names = toArray(s.name);
  return c.kind === "option" ? names.join(", ") : names[0];
}

function needsSpace(c: Candidate, value: string): boolean {
  if (c.suggestion.insertValue?.includes("{cursor}")) return false;
  if (c.kind === "folder") return false;
  return !/[/=:]$/.test(value);
}

function firstLine(s?: string): string {
  return (s ?? "").split("\n")[0].trim();
}

const SPECIAL = /[\s'"\\$`&|;()<>*?[\]{}!#]/g;

function escapeForShell(value: string, cc: CompletionContext): string {
  const quote = cc.token.openQuote ?? (cc.token.raw.startsWith("'") ? "'" : cc.token.raw.startsWith('"') ? '"' : undefined);
  if (quote === "'") return `'${value.replaceAll("'", `'\\''`)}'`;
  if (quote === '"') return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
  // Leave a leading ~ unescaped so it still expands to $HOME.
  const tilde = value.startsWith("~") ? "~" : "";
  return tilde + value.slice(tilde.length).replace(SPECIAL, "\\$&");
}
