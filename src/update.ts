// sprig update: replace this install with the latest GitHub release.
//
// Works for the layout scripts/install.sh creates:
//   <root>/<version>/bin/sprig   (+ share/ next to bin/)
//   <bindir>/sprig -> <root>/<version>/bin/sprig
// Homebrew installs are left to `brew upgrade`; source checkouts to git.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { selfCommand, VERSION } from "./paths.ts";
import { request } from "./setup.ts";

const REPO = "john-rock/sprig";

export type UpdateOptions = {
  /** The running binary; tests point this at a fake install. */
  execPath?: string;
  /** `sprig` as found on PATH, to relink. */
  link?: string | null;
  /** GitHub API base; tests point this at a local server. */
  api?: string;
  platform?: string;
  arch?: string;
  log?: (msg: string) => void;
};

type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] };

/** -1, 0, 1 for dotted numeric versions ("0.1.10" > "0.1.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export async function update(opts: UpdateOptions = {}): Promise<number> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const fail = (m: string) => (log(`sprig update: ${m}`), 1);

  if (!opts.execPath && selfCommand().length > 1) {
    return fail("running from a source checkout; update with `git pull && scripts/install.sh`");
  }
  const exe = realpathSync(opts.execPath ?? process.execPath);
  if (/\/Cellar\//.test(exe)) {
    log("sprig was installed with Homebrew; update with `brew upgrade sprig`");
    return 0;
  }
  const versionDir = dirname(dirname(exe));
  const root = dirname(versionDir);
  if (basename(dirname(exe)) !== "bin" || basename(versionDir) !== VERSION) {
    return fail(`don't know how sprig was installed at ${exe}; reinstall it with scripts/install.sh`);
  }

  // 1. What's the latest release?
  const api = opts.api ?? "https://api.github.com";
  let release: Release;
  try {
    const res = await fetch(`${api}/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": `sprig/${VERSION}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return fail(`no published releases found for ${REPO}`);
    if (!res.ok) return fail(`couldn't check for releases (HTTP ${res.status})`);
    release = (await res.json()) as Release;
  } catch (e) {
    return fail(`couldn't check for releases: ${(e as Error).message}`);
  }
  const latest = release.tag_name.replace(/^v/, "");
  if (compareVersions(latest, VERSION) <= 0) {
    log(`sprig ${VERSION} is up to date`);
    return 0;
  }

  // 2. Download this platform's tarball and check it against SHA256SUMS.
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const name = `sprig-${latest}-${platform}-${arch}.tar.gz`;
  const asset = (n: string) => release.assets.find((a) => a.name === n)?.browser_download_url;
  const tarUrl = asset(name);
  const sumsUrl = asset("SHA256SUMS");
  if (!tarUrl || !sumsUrl) return fail(`release v${latest} has no ${name}`);

  log(`updating sprig ${VERSION} → ${latest}`);
  // Stage next to the install so the final move is a rename on one filesystem.
  mkdirSync(root, { recursive: true });
  const stage = mkdtempSync(join(root, ".update-"));
  try {
    let tarball: Uint8Array;
    let sums: string;
    try {
      [tarball, sums] = await Promise.all([download(tarUrl).then((r) => r.bytes()), download(sumsUrl).then((r) => r.text())]);
    } catch (e) {
      return fail(`download failed: ${(e as Error).message}`);
    }
    const want = sums.split("\n").find((l) => l.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
    const got = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
    if (!want || want !== got) return fail(`checksum mismatch for ${name}; nothing was changed`);

    // 3. Unpack and make sure the new binary runs.
    const tarPath = join(stage, name);
    await Bun.write(tarPath, tarball);
    const untar = Bun.spawnSync(["tar", "-C", stage, "-xzf", tarPath]);
    if (untar.exitCode !== 0) return fail(`couldn't unpack ${name}: ${untar.stderr.toString().trim()}`);
    const newBin = join(stage, "sprig", "bin", "sprig");
    const reported = existsSync(newBin) ? Bun.spawnSync([newBin, "version"]).stdout.toString().trim() : "";
    if (reported !== latest) return fail(`the downloaded binary reports version "${reported}", expected ${latest}`);

    // 4. Swap it in: <root>/<latest>, then repoint the PATH link.
    const dest = join(root, latest);
    rmSync(dest, { recursive: true, force: true });
    renameSync(join(stage, "sprig"), dest);
    const destBin = join(dest, "bin", "sprig");
    const link = opts.link !== undefined ? opts.link : Bun.which("sprig");
    if (link && lstatSync(link).isSymbolicLink() && realpathSync(link) === exe) {
      const tmp = `${link}.sprig-new`;
      rmSync(tmp, { force: true });
      symlinkSync(destBin, tmp);
      renameSync(tmp, link);
      log(`linked ${link} → ${destBin}`);
    } else {
      log(`installed ${destBin} (sprig on your PATH wasn't a link to this install, so it was left alone)`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  // 5. Stop the old daemon and remove old versions (this one included; it's already loaded).
  await request("Q");
  for (const d of readdirSync(root)) {
    if (d !== latest && /^\d+\.\d+\.\d+/.test(d)) rmSync(join(root, d), { recursive: true, force: true });
  }

  // 6. Let the new binary check the setup. If ~/.zshrc names the old path
  //    (sprig wasn't on PATH at install time), `install` rewrites that line.
  const newBin = join(root, latest, "bin", "sprig");
  const rc = join(process.env.ZDOTDIR || homedir(), ".zshrc");
  const rcText = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const step = rcText.includes(versionDir) ? "install" : "doctor";
  const proc = Bun.spawn([newBin, step], { stdio: ["ignore", "pipe", "pipe"] });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  await proc.exited;
  if (out.trim()) log(out.trimEnd());
  log(`\nsprig ${latest} installed. Open a new terminal tab (or run \`exec zsh\`) to use it.`);
  return 0;
}

async function download(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": `sprig/${VERSION}` }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}
