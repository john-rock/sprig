import { homedir } from "node:os";
import { basename, join } from "node:path";

export const VERSION = "0.1.3";

export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "sprig");
}

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "sprig");
}

/** How to run this sprig: the compiled binary, or bun + the entry script in development. */
export function selfCommand(): string[] {
  const exe = process.execPath;
  return basename(exe) === "bun" ? [exe, Bun.main] : [exe];
}

/** macOS limits unix socket paths to 104 bytes (sun_path), Linux to 108. */
const MAX_SOCKET_PATH = 100;

/** One socket per version, so an upgrade never talks to an old daemon. */
export function socketPath(): string {
  if (process.env.SPRIG_SOCKET) return process.env.SPRIG_SOCKET;
  const name = `sprig-${VERSION}.sock`;
  const preferred = join(stateDir(), name);
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred;
  return join(process.env.TMPDIR || "/tmp", `sprig-${process.getuid?.() ?? "user"}`, name);
}
