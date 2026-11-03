// Drives a real interactive zsh through a headless terminal (pyte) and checks
// what is drawn on screen. Needs Python with pyte: set SPRIG_PYTHON to that
// interpreter (e.g. a venv with `pip install pyte`); skipped otherwise.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const python = process.env.SPRIG_PYTHON;
const repo = join(import.meta.dir, "..");

type Step = ["keys", string] | ["snap", string] | ["wait", number];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sprig-it-"));
  const work = join(root, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", work, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "feature/login");
  const rc = join(root, "rc.zsh");
  writeFileSync(
    rc,
    [
      `export XDG_STATE_HOME=${root}/state SPRIG_SOCKET=${root}/s.sock`,
      `cd ${work}`,
      `alias g=git`,
      `eval "$(${process.execPath} ${repo}/src/cli.ts init zsh)"`,
    ].join("\n"),
  );
  return { root, rc };
}

function run(steps: Step[]): Record<string, string> {
  const { root, rc } = setup();
  const stepsFile = join(root, "steps.json");
  writeFileSync(stepsFile, JSON.stringify([["wait", 1.5], ...steps]));
  const out = Bun.spawnSync([python!, "-I", join(repo, "test/harness/screen.py"), rc, stepsFile]).stdout.toString();
  // Stop this test's daemon.
  Bun.spawnSync(["zsh", "-fc", `zmodload zsh/net/socket; zsocket ${root}/s.sock && print -u $REPLY Q`]);
  const snaps: Record<string, string> = {};
  for (const block of out.split("===== ").slice(1)) {
    const [label, ...lines] = block.split("\n");
    snaps[label.replace(/ =====$/, "")] = lines.join("\n");
  }
  return snaps;
}

describe.skipIf(!python)("zsh integration", () => {
  test("dropdown, navigation, accept, dismiss, enter, ctrl-c", () => {
    const s = run([
      ["keys", "git ch"], ["wait", 1], ["snap", "list"],
      ["keys", "\x1b[B\t"], ["wait", 0.8], ["snap", "accepted"],
      ["keys", "\x15git checkout ma\t"], ["wait", 0.8], ["snap", "fast-tab"],
      ["keys", "\x15g co"], ["wait", 0.8], ["snap", "alias"],
      ["keys", "\x1b"], ["wait", 0.8], ["snap", "dismissed"],
      ["keys", "\x15echo ok\r"], ["wait", 0.8], ["snap", "enter"],
      ["keys", "git bra"], ["wait", 0.8], ["keys", "\r"], ["wait", 0.5], ["snap", "enter-insert"],
      ["keys", "\x15git st"], ["wait", 0.8], ["keys", "\x03"], ["wait", 0.5], ["snap", "ctrl-c"],
    ]);
    expect(s.list).toContain("checkout");
    expect(s.list).toContain("cherry-pick");
    expect(s.accepted).toContain("git cherry-pick █");
    expect(s["fast-tab"]).toContain("git checkout main █");
    expect(s.alias).toContain("commit");
    expect(s.dismissed).not.toContain("config");
    expect(s["enter-insert"]).toMatch(/❯ git branch *\n.*feature\/login/);
    expect(s.enter).toMatch(/echo ok\nok\n/);
    expect(s.enter).not.toContain("Environment Variable");
    expect(s["ctrl-c"]).not.toContain("status ");
  }, 60_000);

  // grep's ~9KB option list is bigger than the unix socket buffer; a reply cut
  // short used to leave zsh blocked in `read` and freeze the line editor.
  test("large reply doesn't freeze the shell", () => {
    const s = run([
      ["keys", "grep -"], ["wait", 1], ["snap", "options"],
      ["keys", "\x7fx"], ["wait", 0.8], ["snap", "after"],
    ]);
    expect(s.options).toContain("--ignore-case");
    expect(s.after).toContain("grep x█");
  }, 60_000);

  test("prompt at the bottom of the screen scrolls to fit", () => {
    const s = run([
      ["keys", "for i in {1..40}; do echo line $i; done\r"], ["wait", 0.5],
      ["keys", "git "], ["wait", 1], ["snap", "bottom"],
    ]);
    const lines = s.bottom.split("\n");
    const promptRow = lines.findIndex((l) => l.includes("git █"));
    expect(promptRow).toBeGreaterThan(0);
    expect(lines.slice(promptRow + 1).join("\n")).toMatch(/›/);
  }, 60_000);
});
