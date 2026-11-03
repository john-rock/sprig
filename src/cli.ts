#!/usr/bin/env bun
import { complete } from "./engine/complete.ts";
import { runDaemon } from "./daemon/server.ts";
import { selfCommand, socketPath, VERSION } from "./paths.ts";
import { doctor, install, uninstall } from "./setup.ts";
import { update } from "./update.ts";
import zshScript from "../shell/sprig.zsh" with { type: "text" };

const [cmd, ...rest] = process.argv.slice(2);

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

switch (cmd) {
  case "init": {
    if (rest[0] && rest[0] !== "zsh") {
      console.error(`sprig: only zsh is supported (got ${rest[0]})`);
      process.exit(1);
    }
    process.stdout.write(
      `typeset -ga _sprig_cmd=(${selfCommand().map(shq).join(" ")})\n` +
        `typeset -g _sprig_sock=${shq(socketPath())}\n` +
        zshScript,
    );
    break;
  }
  case "daemon":
    await runDaemon();
    break;
  case "complete": {
    // sprig complete "<text left of cursor>" [--json]
    const json = rest.includes("--json");
    const line = rest.find((a) => a !== "--json") ?? "";
    const r = await complete(line, { cwd: process.cwd() });
    const full = r.more ? await r.more : r;
    if (json) {
      console.log(JSON.stringify(full, null, 2));
    } else {
      for (const it of full.items) console.log(`${it.display.padEnd(28)} ${it.kind.padEnd(10)} ${it.description}`);
    }
    break;
  }
  case "install":
    process.exit(await install());
  case "uninstall":
    process.exit(await uninstall());
  case "update":
    process.exit(await update());
  case "doctor":
    process.exit(await doctor());
  case "--version":
  case "version":
    console.log(VERSION);
    break;
  default:
    console.log(`sprig ${VERSION}: Fig-style autocomplete for zsh

usage:
  sprig install                      add sprig to ~/.zshrc (open a new tab afterwards)
  sprig update                       update to the latest release
  sprig uninstall                    remove sprig from ~/.zshrc and stop the daemon
  sprig doctor                       check that everything is wired up
  sprig complete "<line>" [--json]   show completions for a command line
  sprig init zsh                     print the shell integration (used by ~/.zshrc)`);
}
