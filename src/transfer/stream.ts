import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import type { P2PPeer } from "../p2p/webrtc";
import { TerminalUI, formatBytes } from "../ui/terminal";

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks for optimal WebRTC SCTP throughput

export interface FileMetadata {
  id: string;
  relativePath: string;
  size: number;
  mode?: number;
  checksum?: string;
  isLastFile?: boolean;
}

export interface TransferManifest {
  manifestId: string;
  rootName: string;
  isDirectory: boolean;
  totalFiles: number;
  totalBytes: number;
  files: FileMetadata[];
}

export class FileTransferEngine {
  /**
   * Scan a local path (file or directory) and build a manifest
   */
  static async buildManifest(targetPath: string): Promise<TransferManifest> {
    const resolvedPath = path.resolve(targetPath);
    const stat = fs.statSync(resolvedPath);
    const rootName = path.basename(resolvedPath);

    if (!stat.isDirectory()) {
      return {
        manifestId: "mf_" + Math.random().toString(36).slice(2, 9),
        rootName,
        isDirectory: false,
        totalFiles: 1,
        totalBytes: stat.size,
        files: [
          {
            id: "f_0",
            relativePath: rootName,
            size: stat.size,
            mode: stat.mode,
            isLastFile: true,
          },
        ],
      };
    }

    // Directory recursive scan
    const files: FileMetadata[] = [];
    let totalBytes = 0;
    let fileIdx = 0;

    function walkDir(dir: string, relBase = "") {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.join(relBase, entry.name);

        if (entry.isDirectory()) {
          walkDir(full, rel);
        } else if (entry.isFile()) {
          const s = fs.statSync(full);
          totalBytes += s.size;
          files.push({
            id: `f_${fileIdx++}`,
            relativePath: rel,
            size: s.size,
            mode: s.mode,
          });
        }
      }
    }

    walkDir(resolvedPath, "");
    if (files.length > 0) {
      files[files.length - 1]!.isLastFile = true;
    }

    return {
      manifestId: "mf_" + Math.random().toString(36).slice(2, 9),
      rootName,
      isDirectory: true,
      totalFiles: files.length,
      totalBytes,
      files,
    };
  }

  /**
   * Stream a file or directory over WebRTC DataChannel
   */
  static async send(peer: P2PPeer, targetPath: string): Promise<void> {
    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File or directory does not exist: ${resolvedPath}`);
    }

    const manifest = await FileTransferEngine.buildManifest(resolvedPath);

    TerminalUI.printBanner("P2P File Transfer");
    console.log(pc.dim("  Item:        ") + pc.bold(pc.white(manifest.rootName)));
    console.log(
      pc.dim("  Type:        ") +
        (manifest.isDirectory ? pc.cyan(`Directory (${manifest.totalFiles} files)`) : pc.cyan("Single File"))
    );
    console.log(pc.dim("  Total Size:  ") + pc.yellow(formatBytes(manifest.totalBytes)));
    console.log(pc.dim("─".repeat(Math.min(60, process.stdout.columns || 60))));

    // Inform peer about start of transfer
    peer.sendControl({
      type: "file-start",
      payload: manifest,
    });

    // Wait for peer ready ack
    await new Promise<void>((resolve) => {
      const onAck = (msg: any) => {
        if (msg.type === "file-ack" && msg.payload?.manifestId === manifest.manifestId) {
          peer.off("control-msg", onAck);
          resolve();
        }
      };
      peer.on("control-msg", onAck);
    });

    let overallSentBytes = 0;
    const startTime = Date.now();
    let lastTime = startTime;
    let lastBytes = 0;
    let speedBytesSec = 0;

    for (let i = 0; i < manifest.files.length; i++) {
      const fileMeta = manifest.files[i]!;
      const filePath = manifest.isDirectory
        ? path.join(resolvedPath, fileMeta.relativePath)
        : resolvedPath;

      const hasher = createHash("sha256");
      const fileHandle = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(CHUNK_SIZE);
      let bytesRead = 0;
      let fileSentBytes = 0;

      while ((bytesRead = fs.readSync(fileHandle, buffer, 0, CHUNK_SIZE, fileSentBytes)) > 0) {
        const chunk = buffer.subarray(0, bytesRead);
        hasher.update(chunk);

        // Send binary chunk
        peer.sendFileChunk(chunk);
        fileSentBytes += bytesRead;
        overallSentBytes += bytesRead;

        // Flow control backpressure
        if (peer.getFileBufferedAmount() > 512 * 1024) {
          await peer.waitForFileDrain(256 * 1024);
        }

        // Calculate speed
        const now = Date.now();
        const delta = now - lastTime;
        if (delta >= 250) {
          speedBytesSec = Math.round(((overallSentBytes - lastBytes) / delta) * 1000);
          lastTime = now;
          lastBytes = overallSentBytes;

          TerminalUI.renderProgressBar(
            overallSentBytes,
            manifest.totalBytes,
            `Sending [${i + 1}/${manifest.totalFiles}]`,
            speedBytesSec
          );
        }
      }

      fs.closeSync(fileHandle);
      const computedChecksum = hasher.digest("hex");

      // Notify file end and checksum
      peer.sendControl({
        type: "file-end",
        payload: {
          manifestId: manifest.manifestId,
          fileId: fileMeta.id,
          checksum: computedChecksum,
        },
      });

      // Wait for receiver checksum validation
      await new Promise<void>((resolve, reject) => {
        const onVerify = (msg: any) => {
          if (msg.type === "file-ack" && msg.payload?.fileId === fileMeta.id) {
            peer.off("control-msg", onVerify);
            if (msg.payload.ok) {
              resolve();
            } else {
              reject(new Error(`Checksum mismatch on receiver for file ${fileMeta.relativePath}`));
            }
          }
        };
        peer.on("control-msg", onVerify);
      });
    }

    TerminalUI.renderProgressBar(
      manifest.totalBytes,
      manifest.totalBytes,
      `Completed [${manifest.totalFiles}/${manifest.totalFiles}]`,
      0
    );

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `\n\n${pc.bold(pc.green("✔ Transfer Complete!"))} Sent ${pc.bold(
        formatBytes(manifest.totalBytes)
      )} in ${totalDuration}s\n`
    );
  }

  /**
   * Receive streamed files and write to destination directory
   */
  static async receive(peer: P2PPeer, outputDir = "./"): Promise<void> {
    const destDir = path.resolve(outputDir);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    TerminalUI.printBanner("P2P File Receiver Waiting");
    console.log(pc.dim("  Destination: ") + pc.bold(pc.white(destDir)));
    console.log(pc.dim("  Status:      ") + pc.yellow("Listening for incoming stream on DataChannel...\n"));

    return new Promise((resolve, reject) => {
      let manifest: TransferManifest | null = null;
      let currentFileIndex = 0;
      let currentWriteStream: fs.WriteStream | null = null;
      let currentHasher: ReturnType<typeof createHash> | null = null;
      let currentFileReceivedBytes = 0;
      let overallReceivedBytes = 0;
      let startTime = 0;
      let lastTime = 0;
      let lastBytes = 0;
      let speedBytesSec = 0;

      const onControl = (msg: any) => {
        if (msg.type === "file-start") {
          manifest = msg.payload as TransferManifest;
          currentFileIndex = 0;
          overallReceivedBytes = 0;
          startTime = Date.now();
          lastTime = startTime;

          console.log(pc.bold(pc.cyan(`\nIncoming stream: ${manifest.rootName}`)));
          console.log(
            pc.dim("Total size: ") +
              pc.yellow(formatBytes(manifest.totalBytes)) +
              pc.dim(` (${manifest.totalFiles} files)\n`)
          );

          // Prepare first file write stream
          setupNextFile();

          // Ack start
          peer.sendControl({
            type: "file-ack",
            payload: { manifestId: manifest.manifestId, ok: true },
          });
        } else if (msg.type === "file-end") {
          if (!manifest || !currentHasher || !currentWriteStream) return;

          const fileMeta = manifest.files[currentFileIndex]!;
          const receivedChecksum = currentHasher.digest("hex");
          const expectedChecksum = msg.payload.checksum;

          currentWriteStream.end();
          currentWriteStream = null;

          const matched = receivedChecksum === expectedChecksum;
          if (!matched) {
            peer.sendControl({
              type: "file-ack",
              payload: { fileId: fileMeta.id, ok: false, error: "Checksum mismatch" },
            });
            reject(new Error(`SHA-256 checksum mismatch on file ${fileMeta.relativePath}`));
            return;
          }

          // Restore file mode if provided
          if (fileMeta.mode) {
            try {
              const fullOut = manifest.isDirectory
                ? path.join(destDir, manifest.rootName, fileMeta.relativePath)
                : path.join(destDir, manifest.rootName);
              fs.chmodSync(fullOut, fileMeta.mode);
            } catch {
              // ignore
            }
          }

          peer.sendControl({
            type: "file-ack",
            payload: { fileId: fileMeta.id, ok: true, checksum: receivedChecksum },
          });

          currentFileIndex++;

          if (currentFileIndex < manifest.files.length) {
            setupNextFile();
          } else {
            // All files done
            TerminalUI.renderProgressBar(
              manifest.totalBytes,
              manifest.totalBytes,
              `Received [${manifest.totalFiles}/${manifest.totalFiles}]`,
              0
            );
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(
              `\n\n${pc.bold(pc.green("✔ All Files Received & Verified!"))} Saved to ${pc.cyan(
                destDir
              )} in ${duration}s (SHA-256 verified)\n`
            );
            resolve();
          }
        }
      };

      const setupNextFile = () => {
        if (!manifest) return;
        const meta = manifest.files[currentFileIndex];
        if (!meta) return;

        const targetFilePath = manifest.isDirectory
          ? path.join(destDir, manifest.rootName, meta.relativePath)
          : path.join(destDir, manifest.rootName);

        const targetParent = path.dirname(targetFilePath);
        if (!fs.existsSync(targetParent)) {
          fs.mkdirSync(targetParent, { recursive: true });
        }

        currentFileReceivedBytes = 0;
        currentHasher = createHash("sha256");
        currentWriteStream = fs.createWriteStream(targetFilePath);
      };

      const onFileData = (data: Buffer) => {
        if (!currentWriteStream || !currentHasher || !manifest) return;

        currentWriteStream.write(data);
        currentHasher.update(data);
        currentFileReceivedBytes += data.length;
        overallReceivedBytes += data.length;

        const now = Date.now();
        const delta = now - lastTime;
        if (delta >= 250) {
          speedBytesSec = Math.round(((overallReceivedBytes - lastBytes) / delta) * 1000);
          lastTime = now;
          lastBytes = overallReceivedBytes;

          TerminalUI.renderProgressBar(
            overallReceivedBytes,
            manifest.totalBytes,
            `Receiving [${currentFileIndex + 1}/${manifest.totalFiles}]`,
            speedBytesSec
          );
        }
      };

      peer.on("control-msg", onControl);
      peer.on("file-data", onFileData);
    });
  }
}
