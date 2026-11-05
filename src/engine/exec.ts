// Runs commands on behalf of spec generators, in the user's shell directory.

export type ExecContext = {
  cwd: string;
  env?: Record<string, string>;
};

const MAX_TIMEOUT_MS = 5000;

const stripTrailingNewlines = (s: string) => s.replace(/(\r?\n)+$/, "");

export async function executeCommand(
  input: Fig.ExecuteCommandInput,
  ctx: ExecContext,
): Promise<Fig.ExecuteCommandOutput> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...ctx.env };
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  // Keep tools from paging, prompting or colorizing generator output.
  Object.assign(env, { PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", TERM: "dumb" });

  try {
    const proc = Bun.spawn([input.command, ...(input.args ?? [])], {
      cwd: input.cwd ?? ctx.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: Math.min(input.timeout ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS),
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Fig hands generators output without the trailing newline, and specs rely on it:
    // e.g. git's `remotes` postProcess crashes on the empty last line of `git remote -v`.
    return { stdout: stripTrailingNewlines(stdout), stderr: stripTrailingNewlines(stderr), status };
  } catch (e) {
    return { stdout: "", stderr: String(e), status: 127 };
  }
}
