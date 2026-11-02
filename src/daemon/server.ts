// Long-lived completion daemon. Each zsh session keeps one socket connection open.

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { Socket } from "bun";
import { complete, type Result } from "../engine/complete.ts";
import { socketPath, VERSION } from "../paths.ts";
import { clean, decodeField, US } from "./protocol.ts";
import { flushUsage, recordUse, usageBoost } from "./usage.ts";
import { log, recordLatency } from "./log.ts";

type Conn = { buf: string; aliases: Record<string, string> };

const IDLE_EXIT_MS = 60 * 60_000;

export async function runDaemon(): Promise<void> {
  const path = socketPath();
  mkdirSync(dirname(path), { recursive: true });

  if (await isAlive(path)) return; // another daemon already serves this version
  if (existsSync(path)) unlinkSync(path);

  // The daemon outlives the terminal that started it.
  process.on("SIGHUP", () => {});
  process.chdir(homedir());

  let lastActivity = Date.now();
  const server = Bun.listen<Conn>({
    unix: path,
    socket: {
      open(s) {
        s.data = { buf: "", aliases: {} };
      },
      data(s, chunk) {
        lastActivity = Date.now();
        s.data.buf += chunk.toString();
        let nl: number;
        while ((nl = s.data.buf.indexOf("\n")) >= 0) {
          const line = s.data.buf.slice(0, nl);
          s.data.buf = s.data.buf.slice(nl + 1);
          handle(s, line).catch((e) => log(`error: ${e?.stack ?? e}`));
        }
      },
    },
  });

  const shutdown = () => {
    flushUsage();
    server.stop(true);
    try {
      unlinkSync(path);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  setInterval(() => {
    flushUsage();
    if (Date.now() - lastActivity > IDLE_EXIT_MS) shutdown();
  }, 30_000);
  log(`daemon ${VERSION} listening on ${path}`);
}

async function handle(s: Socket<Conn>, line: string): Promise<void> {
  const f = line.split(US);
  switch (f[0]) {
    case "C": {
      const [, id, cwd, lbuffer] = f;
      const started = performance.now();
      const r = await complete(decodeField(lbuffer ?? ""), { cwd: cwd || homedir() }, usageBoost, s.data.aliases);
      send(s, id, r);
      recordLatency(performance.now() - started);
      if (r.more) send(s, id, await r.more);
      break;
    }
    case "A":
      for (let i = 1; i + 1 < f.length; i += 2) s.data.aliases[f[i]] = f[i + 1];
      break;
    case "U":
      if (f[1] && f[2]) recordUse(f[1], f[2]);
      break;
    case "P":
      s.write(`P${US}${VERSION}\n`);
      break;
    case "Q":
      process.kill(process.pid, "SIGTERM");
      break;
  }
}

function send(s: Socket<Conn>, id: string, r: Result & { specName?: string }): void {
  const fields = ["R", id, String(r.replaceLen), clean(r.specName ?? "")];
  for (const it of r.items) fields.push(clean(it.display), clean(it.insert), clean(it.description), it.kind);
  s.write(fields.join(US) + "\n");
}

function isAlive(path: string): Promise<boolean> {
  if (!existsSync(path)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 500);
    Bun.connect({
      unix: path,
      socket: {
        open(sock) {
          clearTimeout(timer);
          sock.end();
          resolve(true);
        },
        data() {},
        connectError() {
          clearTimeout(timer);
          resolve(false);
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
