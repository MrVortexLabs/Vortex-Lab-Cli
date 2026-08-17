import readline from "node:readline";
import pc from "picocolors";
import { TerminalUI } from "./terminal";
import { parseConnectionString, generateShortRoomCode } from "../utils/network";
import { DEFAULT_GLOBAL_RELAY, DEFAULT_LOCAL_RELAY } from "../p2p/signaling";

export interface MenuItem {
  label: string;
  value: string;
  desc?: string;
}

/**
 * Interactive terminal menu selector with arrow key navigation and numeric shortcuts
 */
export async function interactiveSelect(title: string, items: MenuItem[]): Promise<string> {
  if (!process.stdin.isTTY) {
    // Non-interactive fallback
    console.log(pc.bold(`\n${title}`));
    items.forEach((item, idx) => {
      console.log(`  ${idx + 1}. ${item.label}${item.desc ? pc.dim(` - ${item.desc}`) : ""}`);
    });

    const choice = await TerminalUI.prompt(`\nSelect option (1-${items.length}): `);
    const num = parseInt(choice, 10);
    if (num >= 1 && num <= items.length) {
      return items[num - 1]!.value;
    }
    return items[0]!.value;
  }

  return new Promise((resolve) => {
    let selectedIndex = 0;
    let renderedLines = 0;

    const render = () => {
      // Clear previously rendered lines
      if (renderedLines > 0) {
        process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
      }

      let out = `${pc.bold(pc.cyan("?"))} ${pc.bold(title)}\n`;
      out += pc.dim("  (Use ↑/↓ arrows or number keys, Enter to confirm)\n");

      items.forEach((item, idx) => {
        const isSelected = idx === selectedIndex;
        const prefix = isSelected ? pc.green("➜ ") : "  ";
        const num = pc.dim(`[${idx + 1}] `);
        const label = isSelected ? pc.bold(pc.white(item.label)) : pc.dim(item.label);
        const desc = item.desc ? pc.dim(` (${item.desc})`) : "";

        out += `${prefix}${num}${label}${desc}\n`;
      });

      process.stdout.write(out);
      renderedLines = items.length + 2;
    };

    render();

    const restore = TerminalUI.setupRawMode((data: Buffer) => {
      const str = data.toString();

      // Ctrl+C or Esc
      if (data.length === 1 && (data[0] === 0x03 || data[0] === 0x1b)) {
        restore();
        process.stdout.write("\n");
        process.exit(0);
      }

      // Enter key
      if (data.length === 1 && (data[0] === 0x0d || data[0] === 0x0a)) {
        restore();
        // Clear menu lines and print chosen summary
        process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
        console.log(`${pc.green("✔")} ${pc.bold(title)} ${pc.cyan(items[selectedIndex]!.label)}\n`);
        resolve(items[selectedIndex]!.value);
        return;
      }

      // Up Arrow or 'k'
      if (str === "\u001b[A" || str === "k" || str === "K") {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        render();
        return;
      }

      // Down Arrow or 'j'
      if (str === "\u001b[B" || str === "j" || str === "J") {
        selectedIndex = (selectedIndex + 1) % items.length;
        render();
        return;
      }

      // Number keys 1-9
      const num = parseInt(str, 10);
      if (!isNaN(num) && num >= 1 && num <= items.length) {
        selectedIndex = num - 1;
        restore();
        process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
        console.log(`${pc.green("✔")} ${pc.bold(title)} ${pc.cyan(items[selectedIndex]!.label)}\n`);
        resolve(items[selectedIndex]!.value);
      }
    });
  });
}

export interface WizardHandlers {
  onHost: (options: { room: string; relayUrl: string; mode: "collab" | "view"; isGlobal: boolean }) => Promise<void>;
  onJoin: (options: { room: string; relayUrl: string; mode: "collab" | "view" }) => Promise<void>;
  onSend: (options: { targetPath: string; room: string; relayUrl: string; isGlobal: boolean }) => Promise<void>;
  onReceive: (options: { outputDir: string; room: string; relayUrl: string }) => Promise<void>;
  onServer: (options: { port: number; host: string }) => void;
}

/**
 * Main interactive wizard orchestrator
 */
export async function runInteractiveWizard(handlers: WizardHandlers): Promise<void> {
  TerminalUI.printBanner("Interactive Peer Wizard");

  const action = await interactiveSelect("What would you like to do?", [
    {
      label: "🚀 Host Terminal Session",
      value: "host",
      desc: "Instant Global E2EE Pair-Programming",
    },
    {
      label: "🔗 Join Terminal Session",
      value: "join",
      desc: "Connect using a 4-digit key or link",
    },
    {
      label: "📦 Send File / Folder",
      value: "send",
      desc: "Direct P2P memory-to-memory chunked streaming",
    },
    {
      label: "📥 Receive File / Folder",
      value: "receive",
      desc: "Wait for incoming P2P binary stream",
    },
    {
      label: "⚡ Start Dedicated Signaling Server",
      value: "server",
      desc: "Run standalone WebSocket coordinator",
    },
  ]);

  if (action === "host") {
    const scopeChoice = await interactiveSelect("Select Connection Scope:", [
      { label: "🌍 Global Internet (WAN)", value: "global", desc: "Cross-network pairing from anywhere" },
      { label: "🏠 Local Network (LAN)", value: "local", desc: "Embedded local signaling on port 8765" },
    ]);
    const isGlobal = scopeChoice === "global";

    const modeChoice = await interactiveSelect("Select Access Mode:", [
      { label: "Collab Mode", value: "collab", desc: "Interactive full keyboard control" },
      { label: "View Mode", value: "view", desc: "Read-only spectator mirror" },
    ]);
    const mode = modeChoice === "view" ? "view" : "collab";
    const room = generateShortRoomCode("VTX");
    const relayUrl = isGlobal ? DEFAULT_GLOBAL_RELAY : DEFAULT_LOCAL_RELAY;

    await handlers.onHost({
      room,
      relayUrl,
      mode,
      isGlobal,
    });
  } else if (action === "join") {
    const input = await TerminalUI.prompt("Enter Session Key (e.g. VTX-9821 or VTX-9821@192.168.1.35): ");
    const parsed = parseConnectionString(input);

    let relayUrl = parsed.relayUrl || DEFAULT_GLOBAL_RELAY;

    const modeChoice = await interactiveSelect("Select Join Mode:", [
      { label: "Collab Mode", value: "collab", desc: "Interactive pair-programming" },
      { label: "View Mode", value: "view", desc: "Read-only viewer" },
    ]);
    const mode = modeChoice === "view" ? "view" : "collab";

    await handlers.onJoin({
      room: parsed.room,
      relayUrl,
      mode,
    });
  } else if (action === "send") {
    const filePath = await TerminalUI.prompt("Enter path to File or Folder to send: ");
    const room = generateShortRoomCode("VTX");
    const relayUrl = DEFAULT_GLOBAL_RELAY;

    await handlers.onSend({
      targetPath: filePath.trim(),
      room,
      relayUrl,
      isGlobal: true,
    });
  } else if (action === "receive") {
    const outDir = await TerminalUI.prompt("Enter Destination Directory (default: ./downloads): ");
    const input = await TerminalUI.prompt("Enter Sender's Session Key (e.g. VTX-9821): ");
    const parsed = parseConnectionString(input);

    const relayUrl = parsed.relayUrl || DEFAULT_GLOBAL_RELAY;

    await handlers.onReceive({
      outputDir: outDir.trim() || "./downloads",
      room: parsed.room,
      relayUrl,
    });
  } else if (action === "server") {
    const portStr = await TerminalUI.prompt("Enter Port (default: 8765): ");
    const port = parseInt(portStr.trim() || "8765", 10);
    handlers.onServer({ port, host: "0.0.0.0" });
  }
}
