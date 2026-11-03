// `sprig update` against a fake GitHub API and a fake install made the way
// scripts/install.sh lays it out.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../src/paths.ts";
import { compareVersions, update } from "../src/update.ts";

const NEXT = "9.9.9";
const tarName = `sprig-${NEXT}-testos-testarch.tar.gz`;
const env = { ZDOTDIR: process.env.ZDOTDIR, SPRIG_SOCKET: process.env.SPRIG_SOCKET };
// realpath: update resolves its own path, and macOS tmpdir is behind /var → /private/var.
const work = realpathSync(mkdtempSync(join(tmpdir(), "sprig-update-")));
process.env.ZDOTDIR = work; // no .zshrc here: update runs `doctor`, not `install`
process.env.SPRIG_SOCKET = join(work, "none.sock");

// A release tarball whose binary just reports its version and echoes commands.
const pkg = join(work, "pkg");
mkdirSync(join(pkg, "sprig", "bin"), { recursive: true });
writeFileSync(join(pkg, "sprig", "bin", "sprig"), `#!/bin/sh\ncase "$1" in version) echo ${NEXT};; *) echo "ran $1";; esac\n`);
chmodSync(join(pkg, "sprig", "bin", "sprig"), 0o755);
Bun.spawnSync(["tar", "-C", pkg, "-czf", join(work, tarName), "sprig"]);
const tarball = await Bun.file(join(work, tarName)).bytes();
const goodSum = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");

let latest = NEXT;
let sum = goodSum;
const server = Bun.serve({
  port: 0,
  fetch(req): Response {
    const { pathname: path, origin: base } = new URL(req.url);
    if (path === "/repos/john-rock/sprig/releases/latest") {
      return Response.json({
        tag_name: `v${latest}`,
        assets: [
          { name: tarName, browser_download_url: `${base}/dl/${tarName}` },
          { name: "SHA256SUMS", browser_download_url: `${base}/dl/SHA256SUMS` },
        ],
      });
    }
    if (path === `/dl/${tarName}`) return new Response(tarball);
    if (path === "/dl/SHA256SUMS") return new Response(`${sum}  ${tarName}\n`);
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

/** A fresh install of the current version: <root>/<VERSION>/bin/sprig plus a PATH link to it. */
function fakeInstall() {
  const dir = mkdtempSync(join(work, "install-"));
  const root = join(dir, "share", "sprig");
  const exe = join(root, VERSION, "bin", "sprig");
  mkdirSync(join(root, VERSION, "bin"), { recursive: true });
  writeFileSync(exe, "");
  mkdirSync(join(dir, "bin"));
  const link = join(dir, "bin", "sprig");
  symlinkSync(exe, link);
  const lines: string[] = [];
  const opts = { execPath: exe, link, api: `http://localhost:${server.port}`, platform: "testos", arch: "testarch", log: (m: string) => lines.push(m) };
  return { root, exe, link, lines, opts };
}

describe("sprig update", () => {
  test("installs the newer release, relinks, removes the old version", async () => {
    latest = NEXT;
    sum = goodSum;
    const i = fakeInstall();
    expect(await update(i.opts)).toBe(0);
    expect(readlinkSync(i.link)).toBe(join(i.root, NEXT, "bin", "sprig"));
    expect(existsSync(join(i.root, VERSION))).toBe(false);
    const out = i.lines.join("\n");
    expect(out).toContain(`updating sprig ${VERSION} → ${NEXT}`);
    expect(out).toContain("ran doctor");
  });

  test("does nothing when already on the latest release", async () => {
    latest = VERSION;
    const i = fakeInstall();
    expect(await update(i.opts)).toBe(0);
    expect(i.lines.join("\n")).toContain("is up to date");
    expect(readlinkSync(i.link)).toBe(i.exe);
  });

  test("refuses a tarball that doesn't match SHA256SUMS", async () => {
    latest = NEXT;
    sum = "0".repeat(64);
    const i = fakeInstall();
    expect(await update(i.opts)).toBe(1);
    expect(i.lines.join("\n")).toContain("checksum mismatch");
    expect(readlinkSync(i.link)).toBe(i.exe);
    expect(existsSync(join(i.root, NEXT))).toBe(false);
    expect(existsSync(i.exe)).toBe(true);
  });

  test("leaves Homebrew installs to brew", async () => {
    const exe = join(work, "Cellar", "sprig", VERSION, "bin", "sprig");
    mkdirSync(join(exe, ".."), { recursive: true });
    writeFileSync(exe, "");
    const lines: string[] = [];
    expect(await update({ execPath: exe, log: (m) => lines.push(m) })).toBe(0);
    expect(lines.join("\n")).toContain("brew upgrade sprig");
  });

  test("compareVersions", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.1", "0.1.1")).toBe(0);
    expect(compareVersions("0.2.0", "1.0.0")).toBe(-1);
  });
});
