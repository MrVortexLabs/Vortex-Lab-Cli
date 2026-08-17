import { describe, test, expect } from "bun:test";
import { NativePTY } from "../src/terminal/pty";

describe("Native PTY Engine", () => {
  test("Allocates pseudo-terminal and executes shell command", async () => {
    const pty = new NativePTY();
    expect(pty.masterFd).toBeGreaterThanOrEqual(0);

    let output = "";
    pty.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    const exitPromise = new Promise<number>((resolve) => {
      pty.on("exit", (code: number) => {
        resolve(code);
      });
    });

    pty.spawn("/bin/sh", ["-c", "echo 'BUN_PTY_TEST_SUCCESS'; exit 0"]);

    const exitCode = await exitPromise;
    expect(exitCode).toBe(0);
    expect(output).toContain("BUN_PTY_TEST_SUCCESS");
    pty.close();
  });

  test("PTY resize ioctl executes without errors", () => {
    const pty = new NativePTY();
    expect(() => {
      pty.resize(120, 40);
      pty.resize(80, 24);
    }).not.toThrow();
    pty.close();
  });
});
