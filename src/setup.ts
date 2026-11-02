// install / uninstall / doctor: wiring sprig into the user's shell.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "./engine/complete.ts";
import { specCount } from "./engine/specLoader.ts";
import { selfCommand, socketPath, VERSION } from "./paths.ts";
import { US } from "./daemon/protocol.ts";

const BEGIN = "# >>> sprig >>>";
const END = "# <<< sprig <<<";

const zshrc = () => join(process.env.ZDOTDIR || homedir(), ".zshrc");
const ok = (m: string) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m✘\x1b[0m ${m}`);

/** The line ~/.zshrc runs. Prefer `sprig` from PATH so upgrades keep working. */
function initLine(): string {
  if (Bun.which("sprig") && selfCommand().length === 1) return `command -v sprig >/dev/null && eval "$(sprig init zsh)"`;
  return `eval "$(${selfCommand().map((a) => `'${a}'`).join(" ")} init zsh)"`;
}

function stripBlock(text: string): string {
  const re = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, "g");
  return text.replace(re, "\n");
}

export async function install(): Promise<number> {
  const rc = zshrc();
  const before = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (existsSync(rc)) {
    const backup = `${rc}.sprig-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(rc, backup);
    console.log(`backed up ${rc} → ${backup}`);
  }
  // Always (re)write the block at the very end so sprig wraps keys after other plugins.
  const body = stripBlock(before).replace(/\s*$/, "\n");
  writeFileSync(rc, `${body}\n${BEGIN}\n${initLine()}\n${END}\n`);
  console.log(`added sprig to ${rc}\n`);
  const code = await doctor();
  console.log(`\nOpen a new terminal tab (or run \`exec zsh\`) to start using sprig.`);
  return code;
}

export async function uninstall(): Promise<number> {
  const rc = zshrc();
  if (existsSync(rc)) {
    const text = readFileSync(rc, "utf8");
    if (text.includes(BEGIN)) {
      writeFileSync(rc, stripBlock(text));
      console.log(`removed sprig from ${rc}`);
    } else {
      console.log(`sprig was not in ${rc}`);
    }
  }
  if (await request("Q")) console.log("stopped the sprig daemon");
  console.log("Open a new terminal tab to finish.");
  return 0;
}

/** Send one message to the daemon; resolves to its reply line (or "" for none), undefined if unreachable. */
function request(msg: string, wantReply = false): Promise<string | undefined> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(undefined), 1500);
    let buf = "";
    Bun.connect({
      unix: socketPath(),
      socket: {
        open(s) {
          s.write(msg + "\n");
          if (!wantReply) {
            clearTimeout(timer);
            s.end();
            done("");
          }
        },
        data(s, chunk) {
          buf += chunk.toString();
          if (buf.includes("\n")) {
            clearTimeout(timer);
            s.end();
            done(buf.split("\n")[0]);
          }
        },
        connectError() {
          clearTimeout(timer);
          done(undefined);
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      done(undefined);
    });
  });
}

async function ensureDaemon(): Promise<string | undefined> {
  let pong = await request("P", true);
  if (pong) return pong;
  Bun.spawn([...selfCommand(), "daemon"], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  for (let i = 0; i < 40 && !pong; i++) {
    await Bun.sleep(50);
    pong = await request("P", true);
  }
  return pong;
}

export async function doctor(): Promise<number> {
  let failures = 0;
  console.log(`sprig ${VERSION} doctor`);

  // zsh
  const zv = Bun.spawnSync(["zsh", "-c", "print $ZSH_VERSION"]).stdout.toString().trim();
  const [maj, min] = zv.split(".").map(Number);
  if (!zv) {
    bad("zsh not found");
    failures++;
  } else if (maj < 5 || (maj === 5 && min < 3)) {
    bad(`zsh ${zv} is too old (need 5.3+)`);
    failures++;
  } else if (maj === 5 && min < 9) {
    warn(`zsh ${zv} works; 5.9+ keeps sprig's colors separate from other highlighters`);
  } else {
    ok(`zsh ${zv}`);
  }

  // ~/.zshrc wiring
  const rc = zshrc();
  const text = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (!text.includes(BEGIN)) {
    bad(`not in ${rc}: run \`sprig install\``);
    failures++;
  } else {
    const after = text.slice(text.indexOf(END) + END.length);
    const lateKeyStuff = after
      .split("\n")
      .filter((l) => /^\s*(bindkey|source|zinit|antidote|zplug|plugins=|\. )/.test(l));
    if (lateKeyStuff.length) {
      warn(`lines after sprig in ${rc} may rebind Tab/↑/↓; move sprig's block to the end:\n      ${lateKeyStuff.join("\n      ")}`);
    } else {
      ok(`loaded from ${rc}`);
    }
  }

  // Conflicting tools
  const conflicts: [RegExp, string][] = [
    [/zsh-autocomplete/, "zsh-autocomplete (also draws a live completion list)"],
    [/fzf-tab/, "fzf-tab (also takes over Tab)"],
    [/Q (pre|post) block|amazon-q|qterm|fig\.sh|\.fig\//i, "Amazon Q / Fig shell hooks"],
    [/Kiro CLI (pre|post) block|kiro-cli init/i, "Kiro CLI shell hooks"],
  ];
  const rcFiles = [rc, join(homedir(), ".zprofile"), join(homedir(), ".zshenv"), join(homedir(), ".zlogin")];
  let conflictFound = false;
  for (const f of rcFiles) {
    if (!existsSync(f)) continue;
    const t = readFileSync(f, "utf8");
    for (const [re, what] of conflicts) {
      if (re.test(t)) {
        warn(`${what} found in ${f}`);
        conflictFound = true;
      }
    }
  }
  const qterm = join(homedir(), ".local", "bin", "qterm");
  if (existsSync(qterm)) {
    warn(`leftover Amazon Q terminal wrapper: ${qterm}`);
    conflictFound = true;
  }
  if (!conflictFound) ok("no conflicting autocomplete tools");

  // Specs + engine
  const n = specCount();
  if (n < 100) {
    bad(`only ${n} completion specs found`);
    failures++;
  } else {
    ok(`${n} completion specs`);
  }
  const sample = await complete("git ch", { cwd: homedir() });
  if (sample.items.some((i) => i.display === "checkout")) ok("`git ch` → checkout, cherry-pick …");
  else {
    bad("sample completion failed");
    failures++;
  }

  // Daemon
  const pong = await ensureDaemon();
  if (!pong) {
    bad(`daemon not reachable at ${socketPath()}`);
    failures++;
  } else if (pong !== `P${US}${VERSION}`) {
    warn(`daemon answered with an unexpected version: ${JSON.stringify(pong)}`);
  } else {
    ok("daemon running");
  }

  return failures ? 1 : 0;
}
