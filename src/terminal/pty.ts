import { EventEmitter } from "node:events";
import { dlopen, FFIType, ptr } from "bun:ffi";
import fs from "node:fs";
import os from "node:os";
import pc from "picocolors";
import type { P2PPeer } from "../p2p/webrtc";
import { TerminalUI } from "../ui/terminal";

// Platform-dependent constants and library bindings
const isDarwin = os.platform() === "darwin";
const TIOCSWINSZ = isDarwin ? 0x80087467 : 0x5414;
const TIOCGWINSZ = isDarwin ? 0x40087468 : 0x5413;

let libc: any = null;

function getLibc() {
  if (libc) return libc;

  const libNames = isDarwin
    ? ["libc.dylib", "libutil.dylib"]
    : ["libc.so.6", "libutil.so.1", "libutil.so"];

  for (const name of libNames) {
    try {
      libc = dlopen(name, {
        openpty: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        ioctl: {
          args: [FFIType.i32, FFIType.u64, FFIType.ptr],
          returns: FFIType.i32,
        },
        close: {
          args: [FFIType.i32],
          returns: FFIType.i32,
        },
      });
      if (libc) break;
    } catch {
      // try next
    }
  }

  if (!libc) {
    throw new Error(`Failed to load libc/libutil on platform ${os.platform()}`);
  }

  return libc;
}

export class NativePTY extends EventEmitter {
  public masterFd = -1;
  public slaveFd = -1;
  private readStream: fs.ReadStream | null = null;
  public proc: ReturnType<typeof Bun.spawn> | null = null;
  private isClosed = false;

  constructor() {
    super();
    this.allocatePty();
  }

  private allocatePty(): void {
    try {
      const c = getLibc();
      const masterBuf = new Int32Array(1);
      const slaveBuf = new Int32Array(1);

      const res = c.symbols.openpty(ptr(masterBuf), ptr(slaveBuf), null, null, null);
      if (res !== 0) {
        throw new Error(`openpty failed with code ${res}`);
      }

      this.masterFd = masterBuf[0]!;
      this.slaveFd = slaveBuf[0]!;
    } catch (err) {
      this.close();
      throw new Error(`[bun-p2p] PTY allocation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public resize(cols: number, rows: number): void {
    if (this.masterFd < 0 || this.isClosed) return;
    try {
      const c = getLibc();
      const winsize = new Uint16Array(4);
      winsize[0] = rows;
      winsize[1] = cols;
      winsize[2] = 0;
      winsize[3] = 0;
      c.symbols.ioctl(this.masterFd, TIOCSWINSZ, ptr(winsize));
    } catch {
      // ignore resize error
    }
  }

  public spawn(
    shellPath?: string,
    args: string[] = [],
    env: Record<string, string> = {},
    initialCols = 80,
    initialRows = 24
  ): void {
    const shell = shellPath || process.env.SHELL || (os.platform() === "win32" ? "cmd.exe" : "/bin/bash");

    this.resize(initialCols, initialRows);

    try {
      this.proc = Bun.spawn([shell, ...args], {
        stdin: this.slaveFd,
        stdout: this.slaveFd,
        stderr: this.slaveFd,
        env: {
          ...process.env,
          ...env,
          TERM: process.env.TERM || "xterm-256color",
          COLORTERM: "truecolor",
          BUN_P2P: "1",
        },
      });
    } catch (err) {
      this.close();
      throw new Error(`[bun-p2p] Failed to spawn shell '${shell}': ${err instanceof Error ? err.message : String(err)}`);
    }

    // Close slave fd in parent process
    try {
      const c = getLibc();
      c.symbols.close(this.slaveFd);
      this.slaveFd = -1;
    } catch {
      // ignore
    }

    let exitEmitted = false;
    const emitExitOnce = (code = 0) => {
      if (exitEmitted) return;
      exitEmitted = true;
      this.emit("exit", code);
      setTimeout(() => this.close(), 10);
    };

    // Read master fd output
    try {
      this.readStream = fs.createReadStream("", { fd: this.masterFd });
      this.readStream.on("data", (chunk: Buffer) => {
        this.emit("data", chunk);
      });

      this.readStream.on("error", (err: any) => {
        if (err.code === "EIO" || err.code === "EBADF") {
          emitExitOnce(0);
        } else {
          this.emit("error", err);
        }
      });

      this.readStream.on("end", () => {
        emitExitOnce(0);
      });
    } catch (err) {
      emitExitOnce(1);
    }

    this.proc.exited.then((code) => {
      // Give the stream a moment to drain any pending buffer
      setTimeout(() => {
        emitExitOnce(code);
      }, 50);
    });
  }

  public write(data: Buffer | string): void {
    if (this.masterFd < 0 || this.isClosed) return;
    try {
      const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
      fs.writeSync(this.masterFd, buf);
    } catch {
      // ignore write errors when process is closing
    }
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      if (this.readStream) {
        this.readStream.destroy();
        this.readStream = null;
      }
    } catch {
      // ignore
    }

    try {
      if (this.masterFd >= 0) {
        const c = getLibc();
        c.symbols.close(this.masterFd);
        this.masterFd = -1;
      }
    } catch {
      // ignore
    }

    try {
      if (this.slaveFd >= 0) {
        const c = getLibc();
        c.symbols.close(this.slaveFd);
        this.slaveFd = -1;
      }
    } catch {
      // ignore
    }

    try {
      if (this.proc) {
        this.proc.kill();
        this.proc = null;
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Host a shared terminal session with remote peer
 */
export async function hostTerminalSession(
  peer: P2PPeer,
  options: {
    mode: "collab" | "view";
    shell?: string;
    room?: string;
  }
): Promise<void> {
  const pty = new NativePTY();
  let currentMode = options.mode;
  let restoreRawMode: (() => void) | null = null;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  TerminalUI.printBanner("Terminal Session Live");
  console.log(
    pc.dim("  Session Mode: ") +
      (currentMode === "collab" ? pc.bold(pc.green("COLLAB (Interactive)")) : pc.bold(pc.yellow("VIEW (Read-Only)")))
  );
  console.log(pc.dim("  Hotkeys:      ") + pc.cyan("Ctrl+]") + pc.dim(" for menu | ") + pc.cyan("Ctrl+Q") + pc.dim(" to exit\n"));

  pty.spawn(options.shell, [], {}, cols, rows);

  // Send initial dimension and mode handshake
  peer.sendControl({
    type: "handshake",
    payload: {
      mode: currentMode,
      cols,
      rows,
      room: options.room,
    },
  });

  // Pipe PTY master output -> stdout & WebRTC peer
  pty.on("data", (data: Buffer) => {
    try {
      process.stdout.write(data);
      peer.sendPty(data);
    } catch {
      // ignore
    }
  });

  // Handle peer incoming keystrokes
  peer.on("pty-data", (data: Buffer) => {
    if (currentMode === "collab") {
      pty.write(data);
    }
  });

  // Handle control messages (resize, mode-change)
  peer.on("control-msg", (msg) => {
    if (msg.type === "resize" && msg.payload) {
      pty.resize(msg.payload.cols, msg.payload.rows);
    } else if (msg.type === "mode-change" && msg.payload?.mode) {
      currentMode = msg.payload.mode;
    }
  });

  // Handle local terminal resize
  const onResize = () => {
    const newCols = process.stdout.columns || 80;
    const newRows = process.stdout.rows || 24;
    pty.resize(newCols, newRows);
    peer.sendControl({
      type: "resize",
      payload: { cols: newCols, rows: newRows },
    });
  };
  process.stdout.on("resize", onResize);

  // Enter local raw mode so Host typing goes into PTY
  restoreRawMode = TerminalUI.setupRawMode((data: Buffer) => {
    // Check hotkeys: Ctrl+] (0x1D) or Ctrl+Q (0x11)
    if (data.length === 1 && (data[0] === 0x1d || data[0] === 0x11)) {
      showHostOverlayMenu(peer, pty, currentMode, (newMode) => {
        currentMode = newMode;
      });
      return;
    }

    pty.write(data);
  });

  const cleanup = () => {
    process.stdout.off("resize", onResize);
    if (restoreRawMode) {
      restoreRawMode();
      restoreRawMode = null;
    }
    pty.close();
    peer.close();
    TerminalUI.restoreTerminalState();
  };

  TerminalUI.registerCleanup(cleanup);
  pty.on("exit", () => {
    cleanup();
    console.log(pc.yellow("\n[bun-p2p] Host shell exited."));
    process.exit(0);
  });

  peer.on("disconnected", () => {
    console.log(pc.yellow("\n[bun-p2p] Client disconnected."));
  });
}

/**
 * Join and render a remote terminal session
 */
export async function joinTerminalSession(
  peer: P2PPeer,
  options: {
    mode: "collab" | "view";
    room?: string;
  }
): Promise<void> {
  let currentMode = options.mode;
  let restoreRawMode: (() => void) | null = null;

  TerminalUI.printBanner("Remote Terminal Mirror");
  console.log(
    pc.dim("  Session Mode: ") +
      (currentMode === "collab" ? pc.bold(pc.green("COLLAB (Interactive)")) : pc.bold(pc.yellow("VIEW (Read-Only)")))
  );
  console.log(pc.dim("  Hotkeys:      ") + pc.cyan("Ctrl+]") + pc.dim(" for menu | ") + pc.cyan("Ctrl+Q") + pc.dim(" to exit\n"));

  // Send local dimensions to host
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  peer.sendControl({
    type: "resize",
    payload: { cols, rows },
  });

  // Handle incoming PTY ANSI stream
  peer.on("pty-data", (data: Buffer) => {
    try {
      process.stdout.write(data);
    } catch {
      // ignore
    }
  });

  // Handle control messages
  peer.on("control-msg", (msg) => {
    if (msg.type === "handshake" && msg.payload?.mode) {
      currentMode = msg.payload.mode;
    }
  });

  // Sync client resize
  const onResize = () => {
    const newCols = process.stdout.columns || 80;
    const newRows = process.stdout.rows || 24;
    peer.sendControl({
      type: "resize",
      payload: { cols: newCols, rows: newRows },
    });
  };
  process.stdout.on("resize", onResize);

  const cleanup = () => {
    process.stdout.off("resize", onResize);
    if (restoreRawMode) {
      restoreRawMode();
      restoreRawMode = null;
    }
    peer.close();
    TerminalUI.restoreTerminalState();
  };

  TerminalUI.registerCleanup(cleanup);

  // Setup client raw mode
  restoreRawMode = TerminalUI.setupRawMode((data: Buffer) => {
    // Check hotkey: Ctrl+] (0x1D) or Ctrl+Q (0x11)
    if (data.length === 1 && (data[0] === 0x1d || data[0] === 0x11)) {
      showClientOverlayMenu(peer, currentMode, (newMode) => {
        currentMode = newMode;
      });
      return;
    }

    if (currentMode === "collab") {
      peer.sendPty(data);
    } else {
      // In view mode, Ctrl+C exits
      if (data.length === 1 && data[0] === 0x03) {
        cleanup();
        console.log(pc.yellow("\n[bun-p2p] Disconnected from view session."));
        process.exit(0);
      }
    }
  });

  peer.on("disconnected", () => {
    cleanup();
    console.log(pc.yellow("\n[bun-p2p] Host closed the session."));
    process.exit(0);
  });
}

function showHostOverlayMenu(
  peer: P2PPeer,
  pty: NativePTY,
  currentMode: "collab" | "view",
  onModeChange: (m: "collab" | "view") => void
): void {
  const newMode = currentMode === "collab" ? "view" : "collab";
  onModeChange(newMode);
  peer.sendControl({
    type: "mode-change",
    payload: { mode: newMode },
  });

  process.stdout.write(
    `\r\n${pc.bold(pc.cyan("⚡ bun-p2p"))} ${pc.dim("Mode switched to:")} ${
      newMode === "collab" ? pc.green("COLLAB (Interactive)") : pc.yellow("VIEW (Read-Only)")
    }\r\n`
  );
}

function showClientOverlayMenu(
  peer: P2PPeer,
  currentMode: "collab" | "view",
  onModeChange: (m: "collab" | "view") => void
): void {
  process.stdout.write(
    `\r\n${pc.bold(pc.cyan("⚡ bun-p2p"))} ${pc.yellow("Press Ctrl+C again to disconnect or any key to resume...")}\r\n`
  );
}
