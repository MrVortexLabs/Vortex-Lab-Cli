import { describe, test, expect, afterAll } from "bun:test";
import { P2PPeer } from "../src/p2p/webrtc";

describe("WebRTC DataChannel Peer Connection", () => {
  let hostPeer: P2PPeer | null = null;
  let clientPeer: P2PPeer | null = null;

  afterAll(() => {
    hostPeer?.close();
    clientPeer?.close();
  });

  test("Direct handshake between Host and Client peers over DataChannels", async () => {
    hostPeer = new P2PPeer({ role: "host", peerName: "host-test" });
    clientPeer = new P2PPeer({ role: "client", peerName: "client-test" });

    // Forward signaling directly between peers
    hostPeer.on("local-description", (sdp, type) => {
      clientPeer?.setRemoteDescription(sdp, type);
    });

    hostPeer.on("local-candidate", (candidate, mid) => {
      clientPeer?.addRemoteCandidate(candidate, mid);
    });

    clientPeer.on("local-description", (sdp, type) => {
      hostPeer?.setRemoteDescription(sdp, type);
    });

    clientPeer.on("local-candidate", (candidate, mid) => {
      hostPeer?.addRemoteCandidate(candidate, mid);
    });

    // Wait for both peers to connect all 3 channels
    const hostConnectedPromise = new Promise<void>((resolve) => {
      hostPeer!.on("connected", () => resolve());
    });

    const clientConnectedPromise = new Promise<void>((resolve) => {
      clientPeer!.on("connected", () => resolve());
    });

    await Promise.all([hostConnectedPromise, clientConnectedPromise]);

    expect(hostPeer.sas).not.toBeNull();
    expect(clientPeer.sas).not.toBeNull();
    expect(hostPeer.sas?.code).toBe(clientPeer.sas?.code);

    // Test Control Channel
    const controlMsgPromise = new Promise<any>((resolve) => {
      clientPeer!.on("control-msg", (msg) => {
        resolve(msg);
      });
    });

    hostPeer.sendControl({
      type: "handshake",
      payload: { test: "control-works", mode: "collab" },
    });

    const receivedControl = await controlMsgPromise;
    expect(receivedControl.type).toBe("handshake");
    expect(receivedControl.payload.test).toBe("control-works");

    // Test PTY Channel
    const ptyMsgPromise = new Promise<string>((resolve) => {
      hostPeer!.on("pty-data", (data) => {
        resolve(data.toString("utf-8"));
      });
    });

    clientPeer.sendPty(Buffer.from("echo pty-live-test\n"));
    const receivedPty = await ptyMsgPromise;
    expect(receivedPty).toBe("echo pty-live-test\n");

    // Test File Channel
    const fileDataPromise = new Promise<Buffer>((resolve) => {
      clientPeer!.on("file-data", (data) => {
        resolve(data);
      });
    });

    const testBinary = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xee]);
    hostPeer.sendFileChunk(testBinary);
    const receivedFile = await fileDataPromise;
    expect(Buffer.compare(receivedFile, testBinary)).toBe(0);
  });
});
