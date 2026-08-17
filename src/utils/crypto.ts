import { createHash, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

/**
 * Wordlist for human-friendly Room IDs and SAS (Short Authentication Strings)
 */
const ADJECTIVES = [
  "swift", "silent", "hyper", "quantum", "cosmic", "cyber", "solar", "lunar",
  "atomic", "crypto", "neon", "shadow", "vivid", "turbo", "astral", "zenith",
  "vector", "nexus", "pulse", "matrix", "stellar", "alpha", "omega", "flux"
];

const NOUNS = [
  "falcon", "orbit", "phoenix", "beacon", "voyager", "quasar", "pulsar", "signal",
  "relay", "bridge", "tunnel", "channel", "vertex", "socket", "stream", "packet",
  "router", "gateway", "cluster", "daemon", "tensor", "cipher", "spire", "prism"
];

const SAS_WORDS = [
  "amber", "blaze", "comet", "delta", "echo", "frost", "glyph", "haven",
  "iron", "jade", "kite", "lotus", "mystic", "nova", "opal", "prism",
  "quartz", "ruby", "spark", "topaz", "ultra", "viper", "wave", "xenon",
  "yarrow", "zenith", "anchor", "bravo", "cedar", "dusk", "ember", "forge",
  "garnet", "helix", "iris", "jasper", "karma", "latch", "monolith", "nebula",
  "onyx", "pivot", "quest", "rift", "stride", "titan", "unity", "vortex"
];

/**
 * Generate a clean, human-readable room code (e.g., "swift-falcon-428")
 */
export function generateRoomId(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${adj}-${noun}-${num}`;
}

/**
 * Generate a random unique peer ID
 */
export function generatePeerId(): string {
  return "peer_" + randomBytes(4).toString("hex");
}

/**
 * Calculate SHA-256 checksum of a buffer or string
 */
export function sha256(data: Buffer | Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

/**
 * Generate a Short Authentication String (SAS) from cryptographic material (offer + answer SDP or fingerprints)
 * Returns a 4-word mnemonic and a 6-digit confirmation code.
 */
export function generateSAS(fingerprintA: string, fingerprintB: string): { words: string[]; code: string; emoji: string } {
  // Sort fingerprints so both peers derive the exact same SAS regardless of who initiated
  const combined = [fingerprintA, fingerprintB].sort().join("::");
  const hash = createHash("sha256").update(combined).digest();

  // 4 words from wordlist
  const words: string[] = [];
  for (let i = 0; i < 4; i++) {
    const idx = hash.readUInt16BE(i * 2) % SAS_WORDS.length;
    words.push(SAS_WORDS[idx]!);
  }

  // 6-digit code
  const codeNum = hash.readUInt32BE(8) % 1000000;
  const code = codeNum.toString().padStart(6, "0");

  // Emojis for quick visual match
  const EMOJIS = ["🚀", "⚡", "🔒", "🛰️", "💎", "🛡️", "🔥", "🪐", "🌟", "⚙️", "🔋", "🔑"];
  const emoji = [
    EMOJIS[hash[12]! % EMOJIS.length],
    EMOJIS[hash[13]! % EMOJIS.length],
    EMOJIS[hash[14]! % EMOJIS.length],
  ].join(" ");

  return { words, code, emoji };
}

/**
 * Compress and encode an SDP + candidates payload to a compact base64 string
 */
export function packSdpPayload(data: unknown): string {
  const json = JSON.stringify(data);
  const compressed = deflateSync(Buffer.from(json, "utf-8"), { level: 9 });
  return "BUNP2P:" + compressed.toString("base64url");
}

/**
 * Decode and decompress an SDP payload from a base64 string
 */
export function unpackSdpPayload<T = unknown>(str: string): T {
  let raw = str.trim();
  if (raw.startsWith("BUNP2P:")) {
    raw = raw.slice(7);
  }
  const compressed = Buffer.from(raw, "base64url");
  const decompressed = inflateSync(compressed);
  return JSON.parse(decompressed.toString("utf-8")) as T;
}
