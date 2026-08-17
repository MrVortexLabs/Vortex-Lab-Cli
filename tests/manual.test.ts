import { describe, test, expect } from "bun:test";
import { P2PPeer } from "../src/p2p/webrtc";
import {
  createManualOffer,
  applyManualOffer,
  createManualAnswer,
  applyManualAnswer,
} from "../src/p2p/manual";
import { deserializeManualPayload } from "../src/p2p/signaling";

describe("Manual Air-Gapped Pairing & Pre-Gathered ICE Candidates", () => {
  test("createManualOffer gathers all local ICE candidates into a self-contained token", async () => {
    const hostPeer = new P2PPeer({ role: "host", peerName: "manual-host-test" });

    const offerToken = await createManualOffer(hostPeer, 1000);
    expect(offerToken).toStartWith("BUNP2P:");

    const payload = deserializeManualPayload(offerToken);
    expect(payload.role).toBe("host");
    expect(payload.sdpType).toBe("offer");
    expect(payload.sdp.length).toBeGreaterThan(0);
    // Candidates are populated
    expect(Array.isArray(payload.candidates)).toBeTrue();

    hostPeer.close();
  });

  test("End-to-End air-gapped token exchange connects DataChannels immediately", async () => {
    const hostPeer = new P2PPeer({ role: "host", peerName: "e2e-manual-host" });
    const clientPeer = new P2PPeer({ role: "client", peerName: "e2e-manual-client" });

    const iceStatesHost: string[] = [];
    const iceStatesClient: string[] = [];

    hostPeer.on("ice-state-change", (s) => iceStatesHost.push(s));
    clientPeer.on("ice-state-change", (s) => iceStatesClient.push(s));

    // 1. Host creates self-contained offer
    const offerToken = await createManualOffer(hostPeer, 1000);

    // 2. Client applies offer
    applyManualOffer(clientPeer, offerToken);

    // 3. Client creates self-contained answer
    const answerToken = await createManualAnswer(clientPeer, 1000);

    // 4. Host applies answer
    applyManualAnswer(hostPeer, answerToken);

    // 5. Both peers should connect immediately without secondary trickling
    await Promise.all([
      new Promise<void>((resolve) => hostPeer.on("connected", () => resolve())),
      new Promise<void>((resolve) => clientPeer.on("connected", () => resolve())),
    ]);

    expect(hostPeer.sas).not.toBeNull();
    expect(clientPeer.sas).not.toBeNull();
    expect(hostPeer.sas?.code).toBe(clientPeer.sas?.code);

    // Test sending data on DataChannels
    const msgPromise = new Promise<string>((resolve) => {
      clientPeer.on("pty-data", (data) => resolve(data.toString("utf-8")));
    });

    hostPeer.sendPty("echo manual-airgap-success\n");
    const received = await msgPromise;
    expect(received).toBe("echo manual-airgap-success\n");

    hostPeer.close();
    clientPeer.close();
  });
});
