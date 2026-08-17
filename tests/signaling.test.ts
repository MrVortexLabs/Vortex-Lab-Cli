import { describe, test, expect, afterAll } from "bun:test";
import {
  startSignalingServer,
  WebSocketSignalingClient,
  type SignalData,
} from "../src/p2p/signaling";

describe("Signaling Protocol & Server", () => {
  const PORT = 9876;
  const serverInst = startSignalingServer(PORT, "127.0.0.1");

  afterAll(() => {
    serverInst.close();
  });

  test("Health check endpoint returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
  });

  test("WebSocket Signaling clients can connect and exchange signals within room", async () => {
    const room = "test-room-101";
    const clientA = new WebSocketSignalingClient(`ws://127.0.0.1:${PORT}`, room, "host", "peer_a");
    const clientB = new WebSocketSignalingClient(`ws://127.0.0.1:${PORT}`, room, "client", "peer_b");

    let clientBJoinedReceived = false;
    let signalFromAReceived: SignalData | null = null;

    clientA.on("peer-joined", (peerId) => {
      if (peerId === "peer_b") {
        clientBJoinedReceived = true;
      }
    });

    clientB.on("signal", (data) => {
      signalFromAReceived = data;
    });

    await clientA.connect();
    await clientB.connect();

    // Give a short delay for room join propagation
    await new Promise((r) => setTimeout(r, 50));

    expect(clientBJoinedReceived).toBeTrue();

    // Send signal from A to B
    clientA.sendSignal({ sdp: "dummy-offer-sdp", sdpType: "offer" });

    // Wait for signal delivery
    await new Promise((r) => setTimeout(r, 50));

    expect(signalFromAReceived).not.toBeNull();
    expect(signalFromAReceived?.sdp).toBe("dummy-offer-sdp");
    expect(signalFromAReceived?.sdpType).toBe("offer");

    clientA.close();
    clientB.close();
  });

  test("Connection failure cleanly rejects without unhandled EventEmitter error", async () => {
    // Port 59998 is not listening
    const badClient = new WebSocketSignalingClient("ws://127.0.0.1:59998", "room-fail", "host", "peer_fail");

    // Connect should reject cleanly without throwing unhandled EventEmitter error
    let threw = false;
    try {
      await badClient.connect(1000);
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("Failed to connect to signaling server");
    }

    expect(threw).toBeTrue();
    badClient.close();
  });
});
