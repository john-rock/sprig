// Walks a tokenized command line through a Fig spec to find what the cursor's
// word should complete to.
//
// Behavior follows Fig's autocomplete parser and Microsoft inshellisense
// (MIT, https://github.com/microsoft/inshellisense) but is a fresh implementation.

import type { Token } from "./tokenizer.ts";
import { commandToSpecName, loadSpec } from "./specLoader.ts";
import { executeCommand, type ExecContext } from "./exec.ts";

export type CompletionContext = {
  /** What the word under the cursor is. */
  kind: "args" | "options" | "option-value";
  subcommand: Fig.Subcommand;
  /** Options that can be suggested here (own + inherited persistent ones). */
  options: Fig.Option[];
  passedOptions: Set<Fig.Option>;
  /** Positional or option argument being completed, if any. */
  arg?: Fig.Arg;
  /** Whether subcommand names are valid here. */
  offerSubcommands: boolean;
  /** Also offer positional args / subcommands (an optional option-arg may be skipped). */
  alsoArgs?: { arg?: Fig.Arg; offerSubcommands: boolean };
  /** Value of the word under the cursor, minus `queryPrefix`. */
  query: string;
  /** Part of the word to keep when inserting, e.g. `--format=`. */
  queryPrefix: string;
  /** The word under the cursor. */
  token: Token;
  /** Values of all words of the command, including the one being typed (Fig generator contract). */
  tokens: string[];
  /** Name of the root spec, e.g. "git". */
  specName: string;
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export const toArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

const names = (x: { name?: string | string[] }) => toArray(x.name);

function looksLikeOption(v: string, sub: Fig.Subcommand): boolean {
  if (v.length < 2 || !v.startsWith("-")) {
    // Some CLIs (e.g. `find`, `java`) use non-dash or `+` flags; only treat them as
    // options if the spec actually defines one with that name.
    return v.startsWith("+") && v.length > 1 && (sub.options ?? []).some((o) => names(o).includes(v));
  }
  return true;
}

/** Parse the command the cursor is in. Returns undefined when there is nothing to complete. */
export async function parseCommand(tokens: Token[], ctx: ExecContext): Promise<CompletionContext | undefined> {
  let i = 0;
  while (i < tokens.length - 1 && ENV_ASSIGNMENT.test(tokens[i].value)) i++;
  // Still typing the command name (or an env assignment): no spec to consult.
  if (i >= tokens.length - 1) return undefined;

  const specName = commandToSpecName(tokens[i].value);
  if (!specName) return undefined;
  const spec = await loadSpec(specName);
  if (!spec) return undefined;
  return walk(spec, specName, tokens.slice(i), ctx);
}

async function walk(
  root: Fig.Subcommand,
  specName: string,
  tokens: Token[],
  ctx: ExecContext,
): Promise<CompletionContext | undefined> {
  const values = tokens.map((t) => t.value);
  let sub = await resolveSubcommand(root, values, values.slice(0, 1), ctx);
  let persistent: Fig.Option[] = [];
  const passed = new Set<Fig.Option>();
  let argIdx = 0;
  let positionalCount = 0;
  let pending: { args: Fig.Arg[]; idx: number } | null = null;
  let endOfOptions = false;

  const directives = () => sub.parserDirectives ?? root.parserDirectives ?? {};
  const allOptions = () => [...(sub.options ?? []), ...persistent];
  const findOption = (name: string) => allOptions().find((o) => names(o).includes(name));
  const separators = (opt?: Fig.Option) => {
    const seps = new Set<string>(["="]);
    for (const s of toArray(directives().optionArgSeparators)) seps.add(s);
    if (typeof opt?.requiresSeparator === "string") seps.add(opt.requiresSeparator);
    return [...seps];
  };
  /** Split `--opt=value` / `-o:value` into the option and the kept prefix. */
  const splitOptionValue = (v: string) => {
    for (const sep of separators()) {
      const at = v.indexOf(sep);
      if (at <= 0) continue;
      const opt = findOption(v.slice(0, at));
      if (opt) return { opt, prefix: v.slice(0, at + sep.length), value: v.slice(at + sep.length) };
    }
    return undefined;
  };

  for (let t = 1; t < tokens.length - 1; t++) {
    const tok = tokens[t];
    const v = tok.value;
    if (tok.isRedirectTarget) continue;

    if (pending) {
      const arg = pending.args[pending.idx];
      const breaks =
        !endOfOptions &&
        looksLikeOption(v, sub) &&
        (arg.isOptional || (arg.isVariadic && arg.optionsCanBreakVariadicArg !== false));
      if (!breaks) {
        if (!arg.isVariadic && ++pending.idx >= pending.args.length) pending = null;
        continue;
      }
      pending = null;
    }

    if (!endOfOptions && v === "--") {
      endOfOptions = true;
      continue;
    }

    if (!endOfOptions && looksLikeOption(v, sub)) {
      const opt = findOption(v);
      if (opt) {
        passed.add(opt);
        const args = toArray(opt.args);
        if (args.length) pending = { args, idx: 0 };
        continue;
      }
      const split = splitOptionValue(v);
      if (split) {
        passed.add(split.opt);
        const args = toArray(split.opt.args);
        if (args.length > 1) pending = { args, idx: 1 };
        continue;
      }
      // Chained short flags: -abc, or -ofile where -o takes an argument.
      if (v[1] !== "-" && v.length > 2 && !directives().flagsArePosixNoncompliant) {
        for (let j = 1; j < v.length; j++) {
          const o = findOption(`-${v[j]}`);
          if (!o) break;
          passed.add(o);
          const args = toArray(o.args);
          if (args.length) {
            if (j === v.length - 1) pending = { args, idx: 0 };
            break;
          }
        }
      }
      continue;
    }

    // Positional word.
    if (positionalCount === 0 && sub.subcommands?.length) {
      const next = sub.subcommands.find((s) => names(s).includes(v));
      if (next) {
        persistent = [...persistent, ...(sub.options ?? []).filter((o) => o.isPersistent)];
        sub = await resolveSubcommand(next, values, values.slice(0, t + 1), ctx);
        argIdx = 0;
        passed.clear();
        continue;
      }
    }

    const args = toArray(sub.args);
    const arg = args[argIdx];
    if (arg?.isCommand) {
      // e.g. `sudo git …`, `time npm …`: the rest is its own command.
      const nestedName = commandToSpecName(v);
      if (!nestedName) return undefined;
      const nested = await loadSpec(nestedName);
      return nested ? walk(nested, nestedName, tokens.slice(t), ctx) : undefined;
    }
    if (arg && typeof arg.loadSpec === "string") {
      const nested = await loadSpec(arg.loadSpec);
      return nested ? walk(nested, arg.loadSpec, tokens.slice(t), ctx) : undefined;
    }
    if (arg && !arg.isVariadic) argIdx++;
    positionalCount++;
    if (directives().optionsMustPrecedeArguments) endOfOptions = true;
  }

  const token = tokens[tokens.length - 1];
  const q = token.value;
  const base = {
    subcommand: sub,
    options: allOptions(),
    passedOptions: passed,
    token,
    tokens: values,
    specName,
    query: q,
    queryPrefix: "",
  };
  const positional = () => {
    const arg = toArray(sub.args)[argIdx];
    return { arg, offerSubcommands: positionalCount === 0 && !!sub.subcommands?.length };
  };

  if (token.isRedirectTarget) {
    return { ...base, kind: "args", arg: { template: "filepaths" }, offerSubcommands: false };
  }

  if (pending) {
    const arg = pending.args[pending.idx];
    // An optional option-arg can be skipped, so the next positional is valid too.
    const alsoArgs = arg.isOptional && !q.startsWith("-") ? positional() : undefined;
    if (!(arg.isOptional && q.startsWith("-") && !endOfOptions)) {
      return { ...base, kind: "option-value", arg, offerSubcommands: false, alsoArgs };
    }
  }

  if (!endOfOptions && q.startsWith("-")) {
    const split = splitOptionValue(q);
    if (split && toArray(split.opt.args).length) {
      return {
        ...base,
        kind: "option-value",
        arg: toArray(split.opt.args)[0],
        offerSubcommands: false,
        query: split.value,
        queryPrefix: split.prefix,
      };
    }
    return { ...base, kind: "options", offerSubcommands: false };
  }

  const pos = positional();
  if (pos.arg?.isCommand) return undefined;
  return { ...base, kind: "args", ...pos };
}

// generateSpec results depend on the directory (e.g. git aliases from repo config).
const generatedCache = new Map<string, { at: number; spec: Promise<Fig.Spec | undefined> }>();
const GENERATED_TTL_MS = 5 * 60_000;

/** Apply `loadSpec` / `generateSpec` so the subcommand has its full set of children. */
/** `path` is the words naming this subcommand (e.g. ["git", "checkout"]); it keys the generateSpec cache. */
async function resolveSubcommand(
  s: Fig.Subcommand,
  tokens: string[],
  path: string[],
  ctx: ExecContext,
): Promise<Fig.Subcommand> {
  let out = s;
  if (s.loadSpec) {
    const loaded = await resolveLoadSpec(s.loadSpec, path[path.length - 1] ?? "", ctx);
    if (loaded) out = { ...loaded, name: s.name, description: s.description ?? loaded.description };
  }
  if (out.generateSpec) {
    // Keyed by command path + directory, never by the word being typed.
    const key = `${path.join(" ")}\0${ctx.cwd}`;
    let hit = generatedCache.get(key);
    if (!hit || Date.now() - hit.at > GENERATED_TTL_MS) {
      const exec = (input: Fig.ExecuteCommandInput) => executeCommand(input, ctx);
      hit = {
        at: Date.now(),
        spec: out.generateSpec(tokens, exec).catch(() => undefined) as Promise<Fig.Spec | undefined>,
      };
      generatedCache.set(key, hit);
    }
    const gen = (await hit.spec) as Fig.Subcommand | undefined;
    if (gen && typeof gen === "object") {
      out = {
        ...out,
        subcommands: [...(out.subcommands ?? []), ...(gen.subcommands ?? [])],
        options: [...(out.options ?? []), ...(gen.options ?? [])],
        args: out.args ?? gen.args,
      };
    }
  }
  return out;
}

async function resolveLoadSpec(
  ls: Fig.LoadSpec,
  token: string,
  ctx: ExecContext,
): Promise<Fig.Subcommand | undefined> {
  if (typeof ls === "string") return loadSpec(ls);
  if (typeof ls === "function") {
    try {
      const exec = (input: Fig.ExecuteCommandInput) => executeCommand(input, ctx);
      const r = await ls(token, exec);
      for (const loc of toArray(r as Fig.SpecLocation | Fig.SpecLocation[] | Fig.Subcommand)) {
        if ("type" in loc && (loc.type === "global" || loc.type === "local")) {
          const spec = await loadSpec(loc.name);
          if (spec) return spec;
        } else {
          return loc as Fig.Subcommand;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  return ls;
}
