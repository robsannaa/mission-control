import { spawn, execSync, type ChildProcessWithoutNullStreams } from "child_process";
import { getOpenClawHome } from "@/lib/paths";
import { withPassthroughRoute } from "@/lib/api-route";
import { badRequest, notFound } from "@/lib/api-errors";
import {
  terminalGetQuerySchema,
  terminalPostSchema,
  type TerminalGetQuery,
  type TerminalPostInput,
} from "@/lib/schemas/streaming";

export const dynamic = "force-dynamic";

/* ── Session store (module-level, persists across requests) ── */

type ShellSession = {
  proc: ChildProcessWithoutNullStreams;
  buffer: string[];
  created: number;
  lastActivity: number;
  cwd: string;
  alive: boolean;
  listeners: Set<(event: TerminalEvent) => void>;
};

type TerminalEvent =
  | { type: "output"; text: string }
  | { type: "status"; alive: boolean };

const sessions = new Map<string, ShellSession>();

/* ── Python PTY bridge ──
 *
 * Protocol:
 *   stdin  → raw keystrokes forwarded to the child PTY
 *            EXCEPT lines matching __RESIZE__:cols:rows\n which trigger ioctl
 *   stdout → raw PTY output forwarded to the browser
 *
 * The bridge uses pty.fork() to get a real TTY, handles SIGWINCH via
 * TIOCSWINSZ ioctl, and properly terminates on SIGTERM.
 */
const PY_PTY_BRIDGE = `
import os, pty, select, signal, sys, fcntl, termios, struct, errno

RESIZE_PREFIX = b"__RESIZE__:"

shell = os.environ.get("SHELL", "/bin/zsh")
if not os.path.exists(shell):
    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"]:
        if os.path.exists(candidate):
            shell = candidate
            break

# Parse initial size from argv
init_cols = int(sys.argv[1]) if len(sys.argv) > 1 else 80
init_rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24

pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, "-l"])
    sys.exit(1)

# Set initial terminal size
try:
    winsize = struct.pack("HHHH", init_rows, init_cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    os.kill(pid, signal.SIGWINCH)
except Exception:
    pass

def set_size(cols, rows):
    try:
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass

def _terminate(_signum, _frame):
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, _terminate)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
stdin_buf = b""

while True:
    try:
        r, _, _ = select.select([fd, stdin_fd], [], [], 30.0)
    except (OSError, ValueError):
        break
    except InterruptedError:
        continue

    if not r:
        # Timeout on select — keep looping (allows signal handling)
        continue

    if fd in r:
        try:
            data = os.read(fd, 16384)
        except OSError as e:
            if e.errno == errno.EIO:
                break  # Child exited
            raise
        if not data:
            break
        os.write(stdout_fd, data)

    if stdin_fd in r:
        try:
            data = os.read(stdin_fd, 16384)
        except OSError:
            break
        if not data:
            break
        stdin_buf += data
        # Process resize commands that may be embedded in the stream
        while RESIZE_PREFIX in stdin_buf:
            idx = stdin_buf.index(RESIZE_PREFIX)
            # Write any data before the resize command to the PTY
            if idx > 0:
                os.write(fd, stdin_buf[:idx])
            # Find the newline that ends the resize command
            nl = stdin_buf.find(b"\\n", idx)
            if nl == -1:
                # Incomplete resize command, wait for more data
                stdin_buf = stdin_buf[idx:]
                break
            cmd = stdin_buf[idx + len(RESIZE_PREFIX):nl]
            stdin_buf = stdin_buf[nl + 1:]
            try:
                parts = cmd.split(b":")
                c, rr = int(parts[0]), int(parts[1])
                if 2 <= c <= 500 and 2 <= rr <= 200:
                    set_size(c, rr)
            except Exception:
                pass
        else:
            # No more resize commands — write remaining to PTY
            if stdin_buf:
                os.write(fd, stdin_buf)
                stdin_buf = b""

# Wait for child
try:
    os.waitpid(pid, 0)
except Exception:
    pass
`.trim();

/* ── Helpers ── */

function findPython3(): string {
  // Try common locations
  const candidates = ["python3", "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
  for (const p of candidates) {
    try {
      execSync(`${p} --version`, { stdio: "pipe", timeout: 3000 });
      return p;
    } catch { /* continue */ }
  }
  return "python3"; // fallback, will fail at spawn
}

let cachedPython: string | null = null;
function getPython(): string {
  if (!cachedPython) cachedPython = findPython3();
  return cachedPython;
}

/* ── Cleanup stale sessions every 2 minutes ── */

const SESSION_IDLE_TIMEOUT = 60 * 60 * 1000; // 1 hour idle
const SESSION_MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours absolute max

if (typeof globalThis !== "undefined") {
  const cleanup = () => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (
        !s.alive ||
        now - s.lastActivity > SESSION_IDLE_TIMEOUT ||
        now - s.created > SESSION_MAX_AGE
      ) {
        try { s.proc.kill("SIGTERM"); } catch { /* */ }
        sessions.delete(id);
      }
    }
  };
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.__terminalCleanup) {
    g.__terminalCleanup = setInterval(cleanup, 2 * 60 * 1000);
  }
}

function createSession(cols = 80, rows = 24): string {
  const id = crypto.randomUUID();
  const home = getOpenClawHome();
  const python = getPython();

  const proc = spawn(python, ["-u", "-c", PY_PTY_BRIDGE, String(cols), String(rows)], {
    cwd: home,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
      LANG: process.env.LANG || "en_US.UTF-8",
      HOME: process.env.HOME || "/tmp",
      CLICOLOR: "1",
      CLICOLOR_FORCE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const now = Date.now();
  const session: ShellSession = {
    proc,
    buffer: [],
    created: now,
    lastActivity: now,
    cwd: home,
    alive: true,
    listeners: new Set(),
  };

  const pushEvent = (event: TerminalEvent) => {
    session.lastActivity = Date.now();
    if (event.type === "output") {
      // Coalesce buffer: keep last ~200KB of raw output text for reconnection
      session.buffer.push(event.text);
      let totalLen = 0;
      for (const chunk of session.buffer) totalLen += chunk.length;
      while (totalLen > 200_000 && session.buffer.length > 1) {
        totalLen -= session.buffer.shift()!.length;
      }
    }
    for (const fn of session.listeners) {
      try { fn(event); } catch { /* */ }
    }
  };

  proc.stdout.on("data", (data: Buffer) =>
    pushEvent({ type: "output", text: data.toString() }),
  );
  proc.stderr.on("data", (data: Buffer) =>
    pushEvent({ type: "output", text: data.toString() }),
  );

  proc.on("close", () => {
    session.alive = false;
    pushEvent({ type: "output", text: "\r\n\x1b[90m[Session ended]\x1b[0m\r\n" });
    pushEvent({ type: "status", alive: false });
  });

  proc.on("error", (err) => {
    session.alive = false;
    pushEvent({ type: "output", text: `\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n` });
    pushEvent({ type: "status", alive: false });
  });

  sessions.set(id, session);
  return id;
}

/* ── GET: SSE stream of terminal output ── */

export const GET = withPassthroughRoute<unknown, TerminalGetQuery>(
  { name: "/api/terminal", querySchema: terminalGetQuerySchema },
  async (request, ctx) => {
    const action = ctx.query.action || "stream";
    const sessionId = ctx.query.session || "";

    if (action === "list") {
      const list = [...sessions.entries()].map(([id, s]) => ({
        id,
        alive: s.alive,
        created: s.created,
        age: Math.round((Date.now() - s.created) / 1000),
      }));
      return Response.json({ sessions: list });
    }

    // SSE stream
    if (!sessionId || !sessions.has(sessionId)) {
      return notFound("Invalid session");
    }

    const session = sessions.get(sessionId)!;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        // Replay buffered output for reconnection
        if (session.buffer.length > 0) {
          const replay = session.buffer.join("");
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "output", text: replay })}\n\n`),
          );
        }

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "status", alive: session.alive })}\n\n`),
        );

        const listener = (event: TerminalEvent) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            session.listeners.delete(listener);
          }
        };

        session.listeners.add(listener);

        // Heartbeat to keep connection alive through proxies
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          } catch {
            clearInterval(heartbeat);
          }
        }, 15000);

        request.signal.addEventListener("abort", () => {
          session.listeners.delete(listener);
          clearInterval(heartbeat);
          try { controller.close(); } catch { /* */ }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  },
);

/* ── POST: create session, send input, resize, kill ── */

export const POST = withPassthroughRoute<TerminalPostInput>(
  { name: "/api/terminal", bodySchema: terminalPostSchema },
  async (_request, ctx) => {
    const body = ctx.body;

    switch (body.action) {
      case "create": {
        // `||`, not `??`: a falsy-but-present 0 falls back to the default,
        // matching the pre-migration `Number(body.cols) || 80` behavior.
        const cols = body.cols || 80;
        const rows = body.rows || 24;
        const id = createSession(cols, rows);
        return Response.json({ ok: true, session: id });
      }

      case "input": {
        const sessionId = body.session ?? "";
        // A missing `data` used to reach `stdin.write(undefined)` and throw
        // (Rule 1 — pre-existing bug this schema-typed path now surfaces
        // instead of masking with an `as string` cast).
        const data = body.data ?? "";
        const session = sessions.get(sessionId);
        if (!session || !session.alive) {
          return notFound("Session not found or dead");
        }
        session.lastActivity = Date.now();
        session.proc.stdin.write(data);
        return Response.json({ ok: true });
      }

      case "resize": {
        const sessionId = body.session ?? "";
        const cols = body.cols;
        const rows = body.rows;
        const session = sessions.get(sessionId);
        if (!session || !session.alive) {
          return notFound("Session not found or dead");
        }
        if (!Number.isFinite(cols) || !Number.isFinite(rows) || (cols as number) < 2 || (rows as number) < 2) {
          return badRequest("Invalid cols/rows");
        }
        // Send resize command to the Python PTY bridge via stdin
        session.proc.stdin.write(`__RESIZE__:${cols}:${rows}\n`);
        return Response.json({ ok: true });
      }

      case "kill": {
        const sessionId = body.session ?? "";
        const session = sessions.get(sessionId);
        if (session) {
          try { session.proc.kill("SIGTERM"); } catch { /* */ }
          sessions.delete(sessionId);
        }
        return Response.json({ ok: true });
      }

      default: {
        // Unreachable: the discriminated-union schema above already rejects
        // any `action` outside the four known literals before this handler
        // runs (T-02-06). Kept as a typed exhaustiveness guard, not a live
        // code path.
        const exhaustive: never = body;
        return badRequest(`Unknown action: ${JSON.stringify(exhaustive)}`);
      }
    }
  },
);
