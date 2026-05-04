// Records the audio stream to split MP3 files.
// Files are named <id>_<UTC-start-time>.mp3 and written to a configurable directory.
//
// Split boundaries are aligned to wall-clock UTC (e.g. splitMinutes=10 splits at
// :00, :10, :20, ... past each hour). The first file starts immediately and runs
// until the first boundary; all subsequent files start exactly on a boundary.

import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { AppConfig } from "./types";

class Mp3Recorder extends EventEmitter {
  private config: AppConfig;
  private ffmpeg: ChildProcess | null = null;
  private _splitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: AppConfig) {
    super();
    this.config = config;
  }

  start(): void {
    fs.mkdirSync(this.config.device.recording!.outputDir, { recursive: true });
    this._openNewFile();
  }

  writePcm(pcmData: Buffer): void {
    if (this.ffmpeg && this.ffmpeg.stdin!.writable) {
      this.ffmpeg.stdin!.write(pcmData);
    }
  }

  stop(): void {
    if (this._splitTimer) { clearTimeout(this._splitTimer); this._splitTimer = null; }
    this._closeCurrentFile();
  }

  // ── File management ────────────────────────────────────────────────────────

  private _openNewFile(): void {
    this._closeCurrentFile();

    const { audioSampleRate, modulation, stereo } = this.config.device;
    const outputChannels = (modulation === "wbfm" && stereo) ? 2 : 1;
    const filename = this._filename();

    this.ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(audioSampleRate), "-ac", String(outputChannels),
      "-i", "pipe:0",
      "-c:a", "libmp3lame", "-b:a", "128k",
      filename,
    ], { stdio: ["pipe", "ignore", "pipe"] });

    this.ffmpeg.stderr!.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error(`Recorder: ${msg}`);
    });

    this.ffmpeg.on("error", (err: Error) => {
      console.error(`Recorder FFmpeg error: ${err.message}`);
      this.emit("error", err);
    });

    this.ffmpeg.on("close", (code: number | null) => {
      if (code !== 0 && code !== null) {
        console.warn(`Recorder exited unexpectedly (code ${code})`);
      }
    });

    console.log(`Recording → ${filename}`);
    this._scheduleNextSplit();
  }

  private _closeCurrentFile(): void {
    if (this.ffmpeg) {
      // stdin.end() lets FFmpeg finalise the MP3 cleanly (flush + write end tag)
      try { this.ffmpeg.stdin!.end(); } catch (_) {}
      this.ffmpeg = null;
    }
  }

  // ── Split scheduling ───────────────────────────────────────────────────────

  private _scheduleNextSplit(): void {
    if (this._splitTimer) clearTimeout(this._splitTimer);
    const delay = this._msUntilNextBoundary();
    this._splitTimer = setTimeout(() => this._openNewFile(), delay);
  }

  private _msUntilNextBoundary(): number {
    const now     = Date.now();
    const splitMs = this.config.device.recording!.splitMinutes * 60 * 1000;
    // Next multiple of splitMs since Unix epoch (which is midnight UTC)
    const next    = Math.ceil((now + 500) / splitMs) * splitMs;
    return next - now;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _filename(): string {
    // "2026-05-01T12-00-00Z"  (colons replaced so the name is valid on all OSes)
    const ts = new Date().toISOString()
      .replace(/:/g, "-")
      .replace(/\..+$/, "");
    return path.join(this.config.device.recording!.outputDir, `${this.config.device.id}_${ts}.mp3`);
  }
}

export default Mp3Recorder;
