import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

let cachedNodeDataChannel: any = null;

/**
 * Robust Native Binding Loader for node-datachannel
 * Handles standard node_modules, compiled Bun binaries, and standalone bundles.
 */
export function getNodeDataChannel(): any {
  if (cachedNodeDataChannel) {
    return cachedNodeDataChannel;
  }

  // 1. Try standard import / require
  try {
    const req = createRequire(import.meta.url);
    cachedNodeDataChannel = req("node-datachannel");
    if (cachedNodeDataChannel?.PeerConnection) {
      return cachedNodeDataChannel;
    }
  } catch {
    // Fall back to candidate search paths
  }

  // 2. Search local candidate paths (useful for compiled binaries or standalone distributions)
  const req = createRequire(import.meta.url);
  const execDir = path.dirname(process.execPath);
  const cwd = process.cwd();

  const { platform, arch } = process;
  const candidatePkgNames = [
    `@node-datachannel/${platform}-${arch}-gnu`,
    `@node-datachannel/${platform}-${arch}-musl`,
    `@node-datachannel/${platform}-${arch}`,
    `@node-datachannel/${platform}-${arch}-msvc`,
  ];

  const searchDirs = [
    cwd,
    execDir,
    path.join(cwd, "node_modules"),
    path.join(execDir, "node_modules"),
    path.join(execDir, "lib"),
  ];

  for (const dir of searchDirs) {
    // Check direct .node binaries
    const directFiles = [
      path.join(dir, "node_datachannel.node"),
      path.join(dir, "Release", "node_datachannel.node"),
      path.join(dir, "build", "Release", "node_datachannel.node"),
    ];

    for (const f of directFiles) {
      if (fs.existsSync(f)) {
        try {
          const mod = req(f);
          if (mod?.PeerConnection || mod?.default?.PeerConnection) {
            cachedNodeDataChannel = mod.default || mod;
            return cachedNodeDataChannel;
          }
        } catch {
          // continue searching
        }
      }
    }

    // Check package names
    for (const pkg of candidatePkgNames) {
      const candidatePath = path.join(dir, pkg);
      if (fs.existsSync(candidatePath)) {
        try {
          const mod = req(candidatePath);
          if (mod?.PeerConnection || mod?.default?.PeerConnection) {
            cachedNodeDataChannel = mod.default || mod;
            return cachedNodeDataChannel;
          }
        } catch {
          // continue searching
        }
      }
    }
  }

  throw new Error(
    `[bun-p2p] Could not load native WebRTC bindings ('node-datachannel') for ${platform}-${arch}.\n` +
      `Please ensure 'node-datachannel' is installed via 'bun install', or run using 'bun run src/index.ts'.`
  );
}

export default getNodeDataChannel();
