import { describe, test, expect, afterAll } from "bun:test";
import { ensureSignalingServer } from "../src/p2p/signaling";

describe("Auto & In-Process Signaling Server", () => {
  const TEST_PORT = 9988;
  let s1: ReturnType<typeof ensureSignalingServer> | null = null;
  let s2: ReturnType<typeof ensureSignalingServer> | null = null;

  afterAll(() => {
    s1?.close();
    s2?.close();
  });

  test("ensureSignalingServer starts embedded server when port is available", () => {
    s1 = ensureSignalingServer(TEST_PORT, "127.0.0.1");
    expect(s1.isEmbedded).toBeTrue();
    expect(s1.server).not.toBeNull();
  });

  test("ensureSignalingServer gracefully handles already running server without throwing", () => {
    s2 = ensureSignalingServer(TEST_PORT, "127.0.0.1");
    expect(s2.isEmbedded).toBeFalse();
    expect(s2.server).toBeNull();
  });
});
