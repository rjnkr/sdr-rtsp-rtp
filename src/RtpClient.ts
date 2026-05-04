// Pushes audio as RTP to a remote server, but only while voice is detected.
//
// Voice Activity Detection (VAD) is energy-based: the RMS of each PCM chunk is
// compared against a configurable threshold.  When voice starts, an FFmpeg
// process is spawned and begins streaming.  When the signal falls below the
// threshold for holdOffMs, FFmpeg is stopped and the RTP session ends.
//
// Config (rtpOutput block):
//   host        — remote RTP server IP
//   port        — remote RTP port
//   rtcpPort    — remote RTCP port (default: port + 1)
//   threshold   — RMS threshold for voice detection (0-32767, default 500)
//   holdOffMs   — silence duration before disconnecting (ms, default 2000)

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { DeviceConfig, RtpOutputConfig } from "./types";

const DEFAULT_THRESHOLD  = 500;
const DEFAULT_HOLDOFF_MS = 2000;

class RtpClient extends EventEmitter {
  private config: DeviceConfig;
  private rtpConfig: RtpOutputConfig;
  private ffmpeg: ChildProcess | null = null;
  private _silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private _intentionalStop = false;

  constructor(config: DeviceConfig, rtpConfig: RtpOutputConfig) {
    super();
    this.config    = config;
    this.rtpConfig = rtpConfig;
  }

  start(): void {
    const { host, port } = this.rtpConfig;
    const { label } = this.config;
    const threshold = this.rtpConfig.threshold ?? DEFAULT_THRESHOLD;
    const holdOffMs = this.rtpConfig.holdOffMs  ?? DEFAULT_HOLDOFF_MS;
    console.log(`[${label}] RTP client ready → rtp://${host}:${port}  (VAD threshold=${threshold} holdOff=${holdOffMs}ms)`);
  }

  writePcm(pcmData: Buffer): void {
    const rms = this._rms(pcmData);
    const threshold = this.rtpConfig.threshold ?? DEFAULT_THRESHOLD;

    if (rms >= threshold) {
      this._onVoice(pcmData);
    } else {
      this._onSilence(pcmData);
    }
  }

  stop(): void {
    this._intentionalStop = true;
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    this._disconnect();
  }

  // ── VAD state machine ──────────────────────────────────────────────────────

  private _onVoice(pcmData: Buffer): void {
    // Cancel any pending silence timeout
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }

    // Connect if not already streaming
    if (!this.ffmpeg) this._connect();

    if (this.ffmpeg && this.ffmpeg.stdin!.writable) {
      try { this.ffmpeg.stdin!.write(pcmData); } catch (_) {}
    }
  }

  private _onSilence(pcmData: Buffer): void {
    if (!this.ffmpeg) return;   // Already idle — nothing to do

    // Keep writing during the hold-off period so the tail of speech isn't cut
    if (this.ffmpeg.stdin!.writable) {
      try { this.ffmpeg.stdin!.write(pcmData); } catch (_) {}
    }

    if (!this._silenceTimer) {
      const holdOffMs = this.rtpConfig.holdOffMs ?? DEFAULT_HOLDOFF_MS;
      this._silenceTimer = setTimeout(() => {
        this._silenceTimer = null;
        this._disconnect();
      }, holdOffMs);
    }
  }

  // ── FFmpeg lifecycle ───────────────────────────────────────────────────────

  private _connect(): void {
    const { audioSampleRate, label } = this.config;
    const { host, port, rtcpPort }   = this.rtpConfig;
    const rtcp = rtcpPort ?? (port + 1);
    const outputChannels = (this.config.modulation === "wbfm" && this.config.stereo) ? 2 : 1;
    const url = `rtp://${host}:${port}?rtcpport=${rtcp}`;

    this._intentionalStop = false;

    this.ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(audioSampleRate), "-ac", String(outputChannels),
      "-i", "pipe:0",
      "-acodec", "pcm_alaw", "-ar", "8000",
      "-f", "rtp", url,
    ], { stdio: ["pipe", "ignore", "pipe"] });

    this.ffmpeg.stderr!.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[${label}] RTP client: ${msg}`);
    });

    this.ffmpeg.on("error", (err: Error) => {
      console.error(`[${label}] RTP client FFmpeg error: ${err.message}`);
      this.ffmpeg = null;
      this.emit("error", err);
    });

    this.ffmpeg.on("close", (code: number | null) => {
      this.ffmpeg = null;
      if (!this._intentionalStop) {
        console.warn(`[${label}] RTP client exited unexpectedly (code ${code})`);
        this.emit("close", code);
      }
    });

    console.log(`[${label}] RTP client connected → ${url}`);
  }

  private _disconnect(): void {
    if (!this.ffmpeg) return;
    this._intentionalStop = true;
    const { label } = this.config;
    console.log(`[${label}] RTP client disconnected (silence)`);
    try { this.ffmpeg.stdin!.end();     } catch (_) {}
    try { this.ffmpeg.kill("SIGTERM"); } catch (_) {}
    this.ffmpeg = null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _rms(pcmData: Buffer): number {
    const samples = Math.floor(pcmData.length / 2);
    if (samples === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples * 2; i += 2) {
      const s = pcmData.readInt16LE(i);
      sum += s * s;
    }
    return Math.sqrt(sum / samples);
  }
}

export default RtpClient;
