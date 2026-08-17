import os from "node:os";

export interface LanInterface {
  name: string;
  ip: string;
}

/**
 * Detect all valid IPv4 LAN addresses on the local machine
 */
export function getLanIpAddresses(): LanInterface[] {
  const interfaces = os.networkInterfaces();
  const results: LanInterface[] = [];

  for (const [name, netList] of Object.entries(interfaces)) {
    if (!netList) continue;
    // Prioritize standard ethernet/wifi interfaces, deprioritize virtual/bridge
    const isVirtual = name.startsWith("br-") || name.startsWith("docker") || name.startsWith("veth");

    for (const net of netList) {
      if (net.family === "IPv4" && !net.internal) {
        if (isVirtual) {
          results.push({ name, ip: net.address });
        } else {
          results.unshift({ name, ip: net.address });
        }
      }
    }
  }

  if (results.length === 0) {
    results.push({ name: "loopback", ip: "127.0.0.1" });
  }

  return results;
}

/**
 * Get the best primary LAN IP address for peer sharing
 */
export function getPrimaryLanIp(): string {
  const lans = getLanIpAddresses();
  return lans[0]?.ip || "127.0.0.1";
}

/**
 * Generate a short 4-digit global room code (e.g. VTX-9821)
 */
export function generateShortRoomCode(prefix = "VTX"): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${num}`;
}

export interface ParsedConnection {
  room: string;
  relayUrl: string | null;
}

/**
 * Smart parser for connection strings, global room codes, and full CLI commands
 * Supports:
 * - "VTX-9821" (Global room code)
 * - "VTX-9821@192.168.1.35" (Direct LAN shorthand)
 * - "VTX-9821@192.168.1.35:8765"
 * - "ws://192.168.1.35:8765/VTX-9821"
 * - "wss://relay.bun-p2p.dev/VTX-9821"
 * - "bun-p2p join VTX-9821 --relay wss://relay.bun-p2p.dev"
 * - "vtx join VTX-9821"
 */
export function parseConnectionString(input: string, defaultPort = 8765): ParsedConnection {
  let text = input.trim();

  // If pasted as a full CLI command
  if (text.includes("bun-p2p join") || text.includes("vtx join") || text.includes("vortex-auto join") || text.includes("join ")) {
    const relayMatch = text.match(/--relay\s+([^\s]+)/);
    const roomMatch = text.match(/join\s+([A-Za-z0-9_-]+(?:@[^\s]+)?)/);
    const rawTarget = roomMatch ? roomMatch[1]! : "";
    const relayUrl = relayMatch ? relayMatch[1]! : null;

    if (rawTarget.includes("@")) {
      return parseConnectionString(rawTarget, defaultPort);
    }
    if (rawTarget) {
      return { room: rawTarget, relayUrl };
    }
  }

  // Handle URL format: ws://host:port/room or wss://host:port/room
  if (text.startsWith("ws://") || text.startsWith("wss://")) {
    try {
      const url = new URL(text);
      const room = url.pathname.replace(/^\//, "") || url.hash.replace(/^#/, "");
      const relayUrl = `${url.protocol}//${url.host}`;
      if (room) {
        return { room, relayUrl };
      }
    } catch {
      // continue fallback
    }
  }

  // Handle room@host or room@host:port format (LAN direct)
  if (text.includes("@")) {
    const [roomPart, hostPart] = text.split("@");
    const room = roomPart?.trim() || "";
    let host = hostPart?.trim() || "";
    if (!host.includes(":")) {
      host = `${host}:${defaultPort}`;
    }
    const relayUrl = `ws://${host}`;
    return { room, relayUrl };
  }

  // Handle plain global room code
  return {
    room: text,
    relayUrl: null,
  };
}
