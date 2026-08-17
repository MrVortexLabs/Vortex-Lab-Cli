import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { P2PPeer } from "../src/p2p/webrtc";
import { FileTransferEngine } from "../src/transfer/stream";
import { sha256 } from "../src/utils/crypto";

describe("File Transfer Engine", () => {
  const tmpDir = path.resolve("./.test-tmp");
  const sendDir = path.join(tmpDir, "sender");
  const receiveDir = path.join(tmpDir, "receiver");

  let hostPeer: P2PPeer;
  let clientPeer: P2PPeer;

  beforeAll(async () => {
    fs.mkdirSync(sendDir, { recursive: true });
    fs.mkdirSync(receiveDir, { recursive: true });

    // Create test files
    fs.writeFileSync(path.join(sendDir, "test1.txt"), "Bun P2P File Transfer Test Content Single File 12345");
    
    // Create subdirectory with multiple files
    const subFolder = path.join(sendDir, "nested_folder");
    fs.mkdirSync(subFolder, { recursive: true });
    fs.writeFileSync(path.join(subFolder, "nested1.json"), JSON.stringify({ hello: "world", numbers: [1, 2, 3] }));
    fs.writeFileSync(path.join(subFolder, "nested2.bin"), Buffer.from(new Uint8Array(200 * 1024))); // 200KB binary buffer

    // Connect peers
    hostPeer = new P2PPeer({ role: "host" });
    clientPeer = new P2PPeer({ role: "client" });

    hostPeer.on("local-description", (sdp, type) => clientPeer.setRemoteDescription(sdp, type));
    hostPeer.on("local-candidate", (c, mid) => clientPeer.addRemoteCandidate(c, mid));
    clientPeer.on("local-description", (sdp, type) => hostPeer.setRemoteDescription(sdp, type));
    clientPeer.on("local-candidate", (c, mid) => hostPeer.addRemoteCandidate(c, mid));

    await Promise.all([
      new Promise<void>((r) => hostPeer.on("connected", () => r())),
      new Promise<void>((r) => clientPeer.on("connected", () => r())),
    ]);
  });

  afterAll(() => {
    hostPeer?.close();
    clientPeer?.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("buildManifest correctly structures single file and recursive directory", async () => {
    const singleManifest = await FileTransferEngine.buildManifest(path.join(sendDir, "test1.txt"));
    expect(singleManifest.isDirectory).toBeFalse();
    expect(singleManifest.totalFiles).toBe(1);
    expect(singleManifest.files[0]?.relativePath).toBe("test1.txt");

    const dirManifest = await FileTransferEngine.buildManifest(sendDir);
    expect(dirManifest.isDirectory).toBeTrue();
    expect(dirManifest.totalFiles).toBe(3);
  });

  test("Streams single file across DataChannel with SHA-256 integrity check", async () => {
    const srcFile = path.join(sendDir, "test1.txt");
    const originalChecksum = sha256(fs.readFileSync(srcFile));

    const receivePromise = FileTransferEngine.receive(clientPeer, receiveDir);
    const sendPromise = FileTransferEngine.send(hostPeer, srcFile);

    await Promise.all([sendPromise, receivePromise]);

    const receivedFile = path.join(receiveDir, "test1.txt");
    expect(fs.existsSync(receivedFile)).toBeTrue();
    const receivedChecksum = sha256(fs.readFileSync(receivedFile));
    expect(receivedChecksum).toBe(originalChecksum);
  });

  test("Streams directory hierarchy across DataChannel with verification", async () => {
    const srcFolder = path.join(sendDir, "nested_folder");
    const receiveFolderOut = path.join(receiveDir, "nested_out");

    const receivePromise = FileTransferEngine.receive(clientPeer, receiveFolderOut);
    const sendPromise = FileTransferEngine.send(hostPeer, srcFolder);

    await Promise.all([sendPromise, receivePromise]);

    const receivedNested1 = path.join(receiveFolderOut, "nested_folder", "nested1.json");
    const receivedNested2 = path.join(receiveFolderOut, "nested_folder", "nested2.bin");

    expect(fs.existsSync(receivedNested1)).toBeTrue();
    expect(fs.existsSync(receivedNested2)).toBeTrue();

    const orig2 = sha256(fs.readFileSync(path.join(srcFolder, "nested2.bin")));
    const recv2 = sha256(fs.readFileSync(receivedNested2));
    expect(recv2).toBe(orig2);
  });
});
