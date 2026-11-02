// Shell-aware tokenizer for the text left of the cursor.
//
// We only need enough of the shell grammar to find the command the cursor is in
// and split it into words: quotes, backslash escapes, command separators,
// subshells / command substitution, and redirections.

export type Token = {
  /** Unquoted, unescaped value. */
  value: string;
  /** Raw source text as typed. */
  raw: string;
  /** Offset of the token's first char in the input (code points). */
  start: number;
  /** Open quote char if the token ends inside an unterminated quote. */
  openQuote?: "'" | '"';
  /** The token follows a redirection operator (`>`, `<`, `2>` …). */
  isRedirectTarget?: boolean;
};

export type CommandLine = {
  /** Words of the command containing the cursor. Last entry is the word being typed (may be ""). */
  tokens: Token[];
};

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);

/**
 * Tokenize `input` (everything left of the cursor) and return the words of the
 * innermost command the cursor is in.
 */
export function tokenize(input: string): CommandLine {
  const chars = Array.from(input);
  // Stack of word lists; `$(` / `(` / backtick push, `)` / closing backtick pop.
  const stack: Token[][] = [[]];
  let backtickDepth = 0;
  let current: Token | null = null;
  let quote: "'" | '"' | null = null;
  let pendingRedirect = false;

  const words = () => stack[stack.length - 1];
  const finish = () => {
    if (!current) return;
    if (pendingRedirect) {
      current.isRedirectTarget = true;
      pendingRedirect = false;
    }
    words().push(current);
    current = null;
  };
  const resetCommand = () => {
    finish();
    stack[stack.length - 1] = [];
    pendingRedirect = false;
  };
  const begin = (i: number) => {
    if (!current) current = { value: "", raw: "", start: i };
    return current;
  };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];

    if (quote === "'") {
      current!.raw += c;
      if (c === "'") quote = null;
      else current!.value += c;
      continue;
    }

    if (quote === '"') {
      current!.raw += c;
      if (c === '"') {
        quote = null;
      } else if (c === "\\" && i + 1 < chars.length && '"\\$`\n'.includes(chars[i + 1])) {
        current!.raw += chars[++i];
        current!.value += chars[i];
      } else if (c === "$" && chars[i + 1] === "(") {
        // Command substitution inside double quotes: descend into it.
        current!.raw += chars[++i];
        stack.push([]);
        current = null;
        quote = null;
      } else {
        current!.value += c;
      }
      continue;
    }

    if (c === "\\") {
      const tok = begin(i);
      tok.raw += c;
      if (i + 1 < chars.length) {
        tok.raw += chars[++i];
        if (chars[i] !== "\n") tok.value += chars[i];
      }
      continue;
    }

    if (c === "'" || c === '"') {
      const tok = begin(i);
      tok.raw += c;
      quote = c;
      continue;
    }

    if (c === " " || c === "\t") {
      finish();
      continue;
    }

    if (c === "$" && chars[i + 1] === "(") {
      finish();
      i++;
      stack.push([]);
      continue;
    }

    if (c === "`") {
      finish();
      if (backtickDepth > 0) {
        backtickDepth--;
        if (stack.length > 1) stack.pop();
      } else {
        backtickDepth++;
        stack.push([]);
      }
      continue;
    }

    if (c === "(") {
      finish();
      stack.push([]);
      continue;
    }

    if (c === ")") {
      finish();
      if (stack.length > 1) stack.pop();
      // The enclosing command continues after a `$( … )` word; treat the substitution as one word.
      words().push({ value: "", raw: "", start: i });
      continue;
    }

    if (SEPARATORS.has(c)) {
      resetCommand();
      continue;
    }

    if (c === ">" || c === "<") {
      // `2>`, `&>`: a digit-only word right before the operator is part of it.
      const cur = current as Token | null;
      if (cur && /^\d+$/.test(cur.raw)) current = null;
      finish();
      while (chars[i + 1] === ">" || chars[i + 1] === "&" || chars[i + 1] === "|") i++;
      pendingRedirect = true;
      continue;
    }

    begin(i).raw += c;
    current!.value += c;
  }

  if (current) {
    if (quote) (current as Token).openQuote = quote;
    finish();
  } else {
    // Cursor is after whitespace (or at the start): the word being typed is empty.
    const empty: Token = { value: "", raw: "", start: chars.length };
    if (pendingRedirect) empty.isRedirectTarget = true;
    words().push(empty);
  }

  return { tokens: words() };
}
