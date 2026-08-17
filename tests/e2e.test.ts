import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { startSignalingServer } from "../src/p2p/signaling";
import { sha256 } from "../src/utils/crypto";

describe("E2E Multi-Process CLI Simulation", () => {
  const SIGNAL_PORT = 9999;
  const RELAY_URL = `ws://127.0.0.1:${SIGNAL_PORT}`;
  const ROOM = "e2e-test-room-" + Math.floor(Math.random() * 10000);

  test("CLI File Send & Receive between two child processes", async () => {
    // 1. Start Signaling Server
    const serverInstance = startSignalingServer(SIGNAL_PORT, "127.0.0.1");

    const e2eDir = path.resolve("./.e2e-tmp");
    const e2eSend = path.join(e2eDir, "sender");
    const e2eRecv = path.join(e2eDir, "receiver");
    fs.mkdirSync(e2eSend, { recursive: true });
    fs.mkdirSync(e2eRecv, { recursive: true });

    const sampleFile = path.join(e2eSend, "payload.dat");
    const sampleData = "End-to-end P2P file streaming test data " + Date.now();
    fs.writeFileSync(sampleFile, sampleData);
    const expectedHash = sha256(sampleData);

    // 2. Start Receiver process
    const receiverProc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "receive", e2eRecv, "--room", ROOM, "--relay", RELAY_URL],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Give receiver 200ms to connect to signaling server
    await new Promise((r) => setTimeout(r, 200));

    // 3. Start Sender process
    const senderProc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "send", sampleFile, "--room", ROOM, "--relay", RELAY_URL],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Wait for both processes to complete
    const [senderCode, receiverCode] = await Promise.all([
      senderProc.exited,
      receiverProc.exited,
    ]);

    expect(senderCode).toBe(0);
    expect(receiverCode).toBe(0);

    const receivedFile = path.join(e2eRecv, "payload.dat");
    expect(fs.existsSync(receivedFile)).toBeTrue();
    const actualHash = sha256(fs.readFileSync(receivedFile));
    expect(actualHash).toBe(expectedHash);

    // Cleanup
    serverInstance.close();
    fs.rmSync(e2eDir, { recursive: true, force: true });
  }, 15000);

  test("CLI Terminal Sharing between Host and Client subprocesses", async () => {
    const PTY_PORT = 9998;
    const PTY_RELAY = `ws://127.0.0.1:${PTY_PORT}`;
    const PTY_ROOM = "e2e-pty-room-" + Math.floor(Math.random() * 10000);

    const serverInstance = startSignalingServer(PTY_PORT, "127.0.0.1");

    // 1. Host shares terminal
    const hostProc = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "host",
        "--room",
        PTY_ROOM,
        "--relay",
        PTY_RELAY,
        "--shell",
        "/bin/sh",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Wait for host to connect
    await new Promise((r) => setTimeout(r, 200));

    // 2. Client joins terminal
    const clientProc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "join", PTY_ROOM, "--relay", PTY_RELAY, "--mode", "collab"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Wait for WebRTC P2P DataChannels to establish
    await new Promise((r) => setTimeout(r, 600));

    // Write command into host stdin
    if (hostProc.stdin) {
      hostProc.stdin.write(Buffer.from("echo PTY_PAIR_SESSION_OK\nexit\n"));
      hostProc.stdin.flush();
    }

    // Wait for host shell exit
    const hostCode = await Promise.race([
      hostProc.exited,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Host PTY timed out")), 5000)),
    ]);

    expect(hostCode).toBe(0);

    clientProc.kill();
    serverInstance.close();
  }, 15000);
});

