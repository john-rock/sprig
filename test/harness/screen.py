"""Drive an interactive zsh in a pty and snapshot the rendered screen with pyte.

Usage: python screen.py <rcfile> <steps.json>
steps.json is a list of ["keys", "<text>"] / ["snap", "<label>"] / ["wait", seconds].
Prints each snapshot as plain text, with the cursor marked by a block.
"""
import json
import os
import pty
import select
import sys
import tempfile
import time

import pyte

COLS, ROWS = 100, 24


def main():
    rcfile, steps_path = sys.argv[1], sys.argv[2]
    steps = json.load(open(steps_path))
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)

    # A throwaway ZDOTDIR whose .zshrc loads only the file under test.
    zdotdir = tempfile.mkdtemp(prefix="sprig-zdot-")
    with open(os.path.join(zdotdir, ".zshrc"), "w") as f:
        f.write(f"stty cols {COLS} rows {ROWS}\nPS1='~/dev ❯ '\nsource {rcfile}\n")

    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(TERM="xterm-256color", ZDOTDIR=zdotdir)
        os.execvp("zsh", ["zsh", "-i"])

    # Answer cursor position queries so the shell's DSR logic is exercised.
    screen.write_process_input = lambda data: os.write(fd, data.encode())

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    stream.feed(os.read(fd, 65536))
                except OSError:
                    return

    pump(1.0)
    for step in steps:
        kind, arg = step[0], step[1]
        if kind == "keys":
            os.write(fd, arg.encode())
            pump(0.5)
        elif kind == "wait":
            pump(float(arg))
        elif kind == "snap":
            print(f"===== {arg} =====")
            for y, row in enumerate(screen.display):
                if y == screen.cursor.y:
                    row = row[: screen.cursor.x] + "█" + row[screen.cursor.x + 1 :]
                print(row.rstrip())
            print()
    os.kill(pid, 9)


if __name__ == "__main__":
    main()
