import pc from "picocolors";
import readline from "node:readline";

export interface StatusBarOptions {
  room?: string;
  role: "host" | "client";
  mode: "collab" | "view";
  latencyMs?: number;
  encrypted?: boolean;
  connected: boolean;
  sas?: { words: string[]; code: string; emoji: string };
}

export class TerminalUI {
  private static isRaw = false;
  private static keyListeners: ((data: Buffer) => void)[] = [];
  private static cleanupHooks: (() => void)[] = [];
  private static isCleanedUp = false;

  /**
   * Print a stylized minimalist bun-p2p header banner
   */
  static printBanner(subtitle?: string): void {
    const title = pc.bold(pc.cyan("⚡ bun-p2p"));
    const sub = subtitle ? pc.dim(` — ${subtitle}`) : "";
    console.log(`\n${title}${sub}`);
    console.log(pc.dim("─".repeat(Math.min(60, process.stdout.columns || 60))));
  }

  /**
   * Format badge
   */
  static badge(text: string, color: "green" | "yellow" | "blue" | "magenta" | "cyan" | "red" | "dim" = "blue"): string {
    const colors = {
      green: pc.bgGreen(pc.black(` ${text} `)),
      yellow: pc.bgYellow(pc.black(` ${text} `)),
      blue: pc.bgBlue(pc.black(` ${text} `)),
      magenta: pc.bgMagenta(pc.black(` ${text} `)),
      cyan: pc.bgCyan(pc.black(` ${text} `)),
      red: pc.bgRed(pc.white(` ${text} `)),
      dim: pc.bgWhite(pc.black(` ${text} `)),
    };
    return colors[color] || colors.blue;
  }

  /**
   * Display connection details including SAS Verification
   */
  static printConnectionCard(info: {
    room?: string;
    role: string;
    mode: string;
    sas?: { words: string[]; code: string; emoji: string };
    latencyMs?: number;
  }): void {
    console.log();
    console.log(pc.bold(pc.green("✔ WebRTC PeerConnection Established")));
    console.log(pc.dim("  Protocol:  ") + pc.white("DTLS-SRTP / SCTP DataChannel (E2EE Zero-Relay)"));
    if (info.room) {
      console.log(pc.dim("  Room ID:   ") + pc.cyan(info.room));
    }
    console.log(pc.dim("  Session:   ") + pc.yellow(info.role.toUpperCase()) + pc.dim(" | Mode: ") + pc.magenta(info.mode.toUpperCase()));
    if (info.latencyMs !== undefined) {
      console.log(pc.dim("  Latency:   ") + pc.green(`${info.latencyMs}ms`));
    }
    if (info.sas) {
      console.log(pc.dim("  Security:  ") + pc.bold(pc.cyan(`SAS: [${info.sas.words.join("-")}]`)) + ` (${info.sas.code}) ${info.sas.emoji}`);
    }
    console.log(pc.dim("─".repeat(Math.min(60, process.stdout.columns || 60))));
  }

  /**
   * Enter raw terminal mode for direct PTY interaction
   */
  static setupRawMode(onKey: (data: Buffer) => void): () => void {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        TerminalUI.isRaw = true;
      } catch {
        // ignore
      }
    }

    try {
      process.stdin.resume();
    } catch {
      // ignore
    }

    const listener = (data: Buffer) => {
      onKey(data);
    };

    process.stdin.on("data", listener);
    TerminalUI.keyListeners.push(listener);

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;

      try {
        process.stdin.off("data", listener);
      } catch {
        // ignore
      }

      const idx = TerminalUI.keyListeners.indexOf(listener);
      if (idx !== -1) TerminalUI.keyListeners.splice(idx, 1);

      if (TerminalUI.keyListeners.length === 0 && process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          TerminalUI.isRaw = false;
        } catch {
          // ignore
        }
      }
    };

    TerminalUI.registerCleanup(restore);
    return restore;
  }

  /**
   * Register a cleanup hook on exit
   */
  static registerCleanup(hook: () => void): void {
    TerminalUI.cleanupHooks.push(hook);
    if (TerminalUI.cleanupHooks.length === 1) {
      TerminalUI.initGlobalTraps();
    }
  }

  /**
   * Restore normal terminal state (disables raw mode, unpauses/pauses, restores cursor)
   */
  static restoreTerminalState(): void {
    const hooks = [...TerminalUI.cleanupHooks];
    TerminalUI.cleanupHooks = [];

    for (const hook of hooks) {
      try {
        hook();
      } catch {
        // ignore
      }
    }

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        TerminalUI.isRaw = false;
      } catch {
        // ignore
      }
    }

    // Show cursor, reset ANSI screen attributes
    try {
      process.stdout.write("\x1b[?25h\x1b[0m");
    } catch {
      // ignore
    }
  }

  /**
   * Global trap for graceful terminal restoration
   */
  private static initGlobalTraps(): void {
    const handleExit = (code = 0) => {
      if (TerminalUI.isCleanedUp) return;
      TerminalUI.isCleanedUp = true;
      TerminalUI.restoreTerminalState();
    };

    process.on("SIGINT", () => {
      handleExit(0);
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      handleExit(0);
      process.exit(0);
    });

    process.on("SIGHUP", () => {
      handleExit(0);
      process.exit(0);
    });

    process.on("exit", (code) => {
      handleExit(code);
    });

    process.on("uncaughtException", (err) => {
      handleExit(1);
      console.error(pc.red("\n[bun-p2p] Fatal Error:"), err?.message || err);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason) => {
      handleExit(1);
      console.error(pc.red("\n[bun-p2p] Unhandled Rejection:"), reason);
      process.exit(1);
    });
  }

  /**
   * Clear current line and show a progress bar
   */
  static renderProgressBar(current: number, total: number, label: string, speedBytesSec = 0): void {
    const cols = Math.min(80, process.stdout.columns || 80);
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    const barWidth = Math.max(10, Math.min(30, cols - 45));
    const filled = Math.round((barWidth * percent) / 100);
    const empty = barWidth - filled;

    const bar = pc.green("█".repeat(filled)) + pc.dim("░".repeat(empty));
    const sizeStr = `${formatBytes(current)}/${formatBytes(total)}`;
    const speedStr = speedBytesSec > 0 ? ` ${formatBytes(speedBytesSec)}/s` : "";
    const pctStr = `${percent.toString().padStart(3)}%`;

    const line = `\r ${pc.bold(label)} [${bar}] ${pc.cyan(pctStr)} ${pc.dim(sizeStr)}${pc.yellow(speedStr)}`;
    process.stdout.write(line.slice(0, cols));
  }

  /**
   * Prompt user interactively
   */
  static async prompt(questionText: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(pc.bold(questionText), (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
}

/**
 * Format bytes into human readable string (KB, MB, GB)
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + (sizes[i] || "B");
}
