// Line protocol between the zsh client and the daemon.
//
// Fields are separated by US (0x1f), one message per line. zsh can split these
// with a parameter flag and needs no JSON parser. Newlines inside fields travel
// as RS (0x1e).
//
// client → daemon
//   C <id> <cwd> <lbuffer>            complete the text left of the cursor
//   A <name> <value> [<name> <value>]… shell aliases, sent once per connection
//   U <spec> <insert>                 user accepted a suggestion (for ranking)
//   P                                 ping
//   Q                                 stop the daemon
// daemon → client
//   R <id> <replaceLen> <spec> [<display> <insert> <description> <kind>]…
//   P <version>

export const US = "\x1f";
export const RS = "\x1e";

/** Remove anything that would break the framing or the terminal. */
export function clean(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, (c) => (c === "\t" ? " " : ""));
}

export function decodeField(s: string): string {
  return s.replaceAll(RS, "\n");
}
