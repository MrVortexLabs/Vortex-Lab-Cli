import { describe, test, expect } from "bun:test";
import {
  generateRoomId,
  generatePeerId,
  sha256,
  generateSAS,
  packSdpPayload,
  unpackSdpPayload,
} from "../src/utils/crypto";

describe("Crypto & Encoding Utilities", () => {
  test("generateRoomId produces valid format", () => {
    const room = generateRoomId();
    expect(room).toBeString();
    expect(room).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });

  test("generatePeerId produces random unique peer ID", () => {
    const p1 = generatePeerId();
    const p2 = generatePeerId();
    expect(p1).toStartWith("peer_");
    expect(p2).toStartWith("peer_");
    expect(p1).not.toBe(p2);
  });

  test("sha256 calculates expected hex hash", () => {
    const hash = sha256("hello world");
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  test("generateSAS is order-independent (symmetric verification)", () => {
    const fpA = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55";
    const fpB = "11:22:33:44:55:66:77:88:99:AA:BB:CC";

    const sas1 = generateSAS(fpA, fpB);
    const sas2 = generateSAS(fpB, fpA);

    expect(sas1.words).toEqual(sas2.words);
    expect(sas1.code).toBe(sas2.code);
    expect(sas1.emoji).toBe(sas2.emoji);
    expect(sas1.words.length).toBe(4);
    expect(sas1.code.length).toBe(6);
  });

  test("packSdpPayload and unpackSdpPayload preserves complex data structures", () => {
    const sample = {
      role: "host",
      sdp: "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=sendrecv",
      sdpType: "offer",
      candidates: [
        { candidate: "candidate:1 1 UDP 2130706431 192.168.1.10 5000 typ host", mid: "0" },
        { candidate: "candidate:2 1 UDP 1694498815 10.0.0.5 5001 typ srflx", mid: "0" },
      ],
    };

    const token = packSdpPayload(sample);
    expect(token).toStartWith("BUNP2P:");

    const decoded = unpackSdpPayload<typeof sample>(token);
    expect(decoded).toEqual(sample);
  });
});
