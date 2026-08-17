import { describe, test, expect } from "bun:test";
import {
  getLanIpAddresses,
  getPrimaryLanIp,
  generateShortRoomCode,
  parseConnectionString,
} from "../src/utils/network";

describe("Network Discovery & Connection Parsing", () => {
  test("getLanIpAddresses returns valid IPv4 addresses", () => {
    const list = getLanIpAddresses();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]?.ip).toBeString();
  });

  test("getPrimaryLanIp returns valid string", () => {
    const ip = getPrimaryLanIp();
    expect(ip).toBeString();
    expect(ip.length).toBeGreaterThan(0);
  });

  test("generateShortRoomCode generates short prefixed code", () => {
    const code = generateShortRoomCode("VTX");
    expect(code).toMatch(/^VTX-\d{4}$/);
  });

  test("parseConnectionString parses plain room code", () => {
    const res = parseConnectionString("VTX-123");
    expect(res.room).toBe("VTX-123");
    expect(res.relayUrl).toBeNull();
  });

  test("parseConnectionString parses room@host shorthand", () => {
    const res = parseConnectionString("VTX-123@192.168.1.50");
    expect(res.room).toBe("VTX-123");
    expect(res.relayUrl).toBe("ws://192.168.1.50:8765");
  });

  test("parseConnectionString parses room@host:customPort", () => {
    const res = parseConnectionString("VTX-123@10.0.0.5:9090");
    expect(res.room).toBe("VTX-123");
    expect(res.relayUrl).toBe("ws://10.0.0.5:9090");
  });

  test("parseConnectionString parses WebSocket URL format", () => {
    const res = parseConnectionString("ws://192.168.1.50:8765/VTX-999");
    expect(res.room).toBe("VTX-999");
    expect(res.relayUrl).toBe("ws://192.168.1.50:8765");
  });

  test("parseConnectionString parses full CLI join command string", () => {
    const res = parseConnectionString("bun-p2p join VTX-777 --relay ws://192.168.1.50:8765");
    expect(res.room).toBe("VTX-777");
    expect(res.relayUrl).toBe("ws://192.168.1.50:8765");
  });
});
