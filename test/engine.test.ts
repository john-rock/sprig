import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenize } from "../src/engine/tokenizer.ts";
import { complete } from "../src/engine/complete.ts";

const dir = mkdtempSync(join(tmpdir(), "sprig-test-"));
mkdirSync(join(dir, "src"));
mkdirSync(join(dir, "my dir"));
writeFileSync(join(dir, "README.md"), "");
writeFileSync(join(dir, ".hidden"), "");

const ctx = { cwd: dir };
const run = async (line: string) => {
  const r = await complete(line, ctx);
  return r.more ? await r.more : r;
};
const inserts = async (line: string) => (await run(line)).items.map((i) => i.insert);

describe("tokenizer", () => {
  const values = (s: string) => tokenize(s).tokens.map((t) => t.value);
  test.each([
    ["git ch", ["git", "ch"]],
    ["git ", ["git", ""]],
    ["", [""]],
    ["echo 'a b' c", ["echo", "a b", "c"]],
    ['echo "a \\"b\\""', ["echo", 'a "b"']],
    ["echo a\\ b", ["echo", "a b"]],
    ["ls | git br", ["git", "br"]],
    ["a && b; c || git st", ["git", "st"]],
    ["echo $(git sta", ["git", "sta"]],
    ['echo "$(git sta', ["git", "sta"]],
    ["echo `git sta", ["git", "sta"]],
    ["(cd x && git p", ["git", "p"]],
  ])("%p", (input, expected) => expect(values(input)).toEqual(expected));

  test("open quote", () => {
    const t = tokenize("cat 'my d").tokens.at(-1)!;
    expect(t.openQuote).toBe("'");
    expect(t.value).toBe("my d");
  });
  test("redirect target", () => {
    expect(tokenize("ls > ").tokens.at(-1)!.isRedirectTarget).toBe(true);
    expect(tokenize("ls 2>err ").tokens.map((t) => t.value)).toEqual(["ls", "err", ""]);
  });
});

describe("completion", () => {
  test("subcommand prefix", async () => {
    expect((await inserts("git ch")).slice(0, 2)).toEqual(["checkout ", "cherry-pick "]);
  });
  test("prefix hits suppress fuzzy noise", async () => {
    expect(await inserts("git ch")).not.toContain("archive ");
  });
  test("typo falls back to fuzzy", async () => {
    expect(await inserts("git chekout")).toContain("checkout ");
  });
  test("options of subcommand", async () => {
    expect(await inserts("git commit --am")).toContain("--amend ");
  });
  test("used options are not suggested again", async () => {
    expect(await inserts("git commit --amend --am")).not.toContain("--amend ");
  });
  test("option args consume the next word", async () => {
    // `-m msg` must not make "msg" count as a positional.
    expect(await inserts("git commit -m msg --am")).toContain("--amend ");
  });
  test("--opt= value completion keeps prefix", async () => {
    const r = await run("git commit --cleanup=");
    expect(r.replaceLen).toBe("--cleanup=".length);
    expect(r.items.map((i) => i.insert)).toContain("--cleanup=strip ");
  });
  test("option value after space", async () => {
    expect(await inserts("git commit --cleanup ")).toContain("strip ");
  });
  test("chained short flags", async () => {
    const items = await inserts("ls -la -");
    expect(items).not.toContain("-l ");
    expect(items).toContain("-h ");
  });
  test("env assignment and precommands", async () => {
    expect(await inserts("FOO=1 git sta")).toContain("status ");
    expect(await inserts("sudo git sta")).toContain("status ");
    expect(await inserts("time git sta")).toContain("status ");
  });
  test("pipes and separators", async () => {
    expect(await inserts("echo hi | git sta")).toContain("status ");
    expect(await inserts("cd x && git sta")).toContain("status ");
  });
  test("unknown command gives nothing", async () => {
    expect(await inserts("definitely-not-a-command --x")).toEqual([]);
  });
  test("typing the command name gives nothing", async () => {
    expect(await inserts("gi")).toEqual([]);
  });
  test("complete unique word gives nothing", async () => {
    expect(await inserts("git status")).toEqual([]);
  });
  test("folders: no trailing space, hidden files only on dot", async () => {
    const items = await inserts("ls ");
    expect(items).toContain("src/");
    expect(items).toContain("README.md ");
    expect(items).not.toContain(".hidden ");
    expect(await inserts("ls .h")).toContain(".hidden ");
  });
  test("`.` and `..` keep the directory first instead of a dotfile", async () => {
    expect((await inserts("code ."))[0]).toBe("./");
    expect((await inserts("ls .."))[0]).toBe("../");
    expect(await inserts("ls ..")).not.toContain("./");
    expect((await inserts("ls src/."))[0]).toBe("src/./");
  });
  test("paths with spaces are escaped", async () => {
    expect(await inserts("ls my")).toContain("my\\ dir/");
  });
  test("quoted path keeps its quote", async () => {
    expect(await inserts("ls 'my")).toContain("'my dir/'");
  });
  test("redirect target completes files", async () => {
    expect(await inserts("echo hi > READ")).toContain("README.md ");
  });
  test("nested subcommand spec via loadSpec", async () => {
    expect(await inserts("docker compose u")).toContain("up ");
  });
  test("git remotes from a script generator", async () => {
    // `git remote -v` ends in a newline; the spec's postProcess only works once it's stripped.
    const repo = mkdtempSync(join(tmpdir(), "sprig-git-"));
    for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/x/y.git"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    }
    const remotes = async (line: string) => {
      const r = await complete(line, { cwd: repo });
      return (r.more ? await r.more : r).items.map((i) => i.insert);
    };
    expect(await remotes("git fetch ")).toContain("origin ");
    expect(await remotes("git fetch o")).toContain("origin ");
    expect(await remotes("git push or")).toContain("origin ");
  });
});
