// Demodulates IQ samples from rtl_tcp in JavaScript, then pipes raw PCM to FFmpeg
// for resampling only. No exotic FFmpeg filters — just aresample and volume.
//
// Data flow:
//   rtl_tcp (u8 IQ) → JS demodulator → s16le PCM → FFmpeg (resample) → RtspServer
//
// rtl_tcp IQ format: interleaved unsigned 8-bit, centre at 128
//   byte 0 = I0, byte 1 = Q0, byte 2 = I1, byte 3 = Q1, ...

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { AppConfig } from "./types";

class DspPipeline extends EventEmitter {
  private config: AppConfig;
  private ffmpeg: ChildProcess | null = null;
  private running = false;

  // FM discriminator state — previous IQ sample for phase difference
  private _prevI = 0;
  private _prevQ = 0;

  // DC blocker state
  private _dcPrev = 0;
  private _dcPrevIn = 0;

  // AM carrier tracker
  private _amDc = 0;

  // Decimation: reduce full SDR rate to ~200 kHz for audio processing
  private readonly _decimFactor: number;
  private _decimCounter = 0;

  constructor(config: AppConfig) {
    super();
    this.config = config;
    this._decimFactor = Math.max(1, Math.floor(config.device.sampleRate / 200000));
  }

  start(): void {
    const { sampleRate, audioSampleRate, modulation, label } = this.config.device;
    const intermediateRate = Math.round(sampleRate / this._decimFactor);
    // Must match the channel count RtspServer declares in the SDP and feeds to its
    // AAC encoder. The JS demodulator always produces mono; FFmpeg upmixes to stereo
    // when outputChannels=2 (duplicating the channel).
    const outputChannels = (modulation === "wbfm" && this.config.device.stereo) ? 2 : 1;

    console.log(`[${label}] Starting DSP pipeline`);
    console.log(`[${label}]   Modulation   : ${modulation.toUpperCase()}`);
    console.log(`[${label}]   IQ rate      : ${(sampleRate / 1e6).toFixed(2)} MSPS`);
    console.log(`[${label}]   Decim factor : ${this._decimFactor}x → ${(intermediateRate / 1000).toFixed(0)} kHz intermediate`);
    console.log(`[${label}]   Output rate  : ${audioSampleRate} Hz  channels: ${outputChannels}`);

    // FFmpeg used only for resampling — no demodulation filters needed
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f",  "s16le",
      "-ar", String(intermediateRate),
      "-ac", "1",
      "-i",  "pipe:0",
      "-af", `aresample=${audioSampleRate},volume=2.0`,
      "-f",  "s16le",
      "-ar", String(audioSampleRate),
      "-ac", String(outputChannels),
      "pipe:1",
    ];

    this.ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.running = true;

    this.ffmpeg.stdout!.on("data", (pcm: Buffer) => {
      this.emit("pcm", pcm);
    });

    this.ffmpeg.stderr!.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[${label}] FFmpeg: ${msg}`);
    });

    this.ffmpeg.on("close", (code: number | null) => {
      this.running = false;
      console.warn(`[${label}] FFmpeg exited (code ${code})`);
      this.emit("close", code);
    });

    this.ffmpeg.on("error", (err: NodeJS.ErrnoException) => {
      console.error(`[${label}] FFmpeg spawn error: ${err.message}`);
      if (err.code === "ENOENT") {
        console.error("  → FFmpeg not found.");
        console.error("    Windows : download from https://ffmpeg.org and add bin\\ to PATH");
        console.error("    Linux   : sudo apt install ffmpeg");
      }
      this.emit("error", err);
    });
  }

  // Receive raw u8 IQ bytes from SdrClient
  write(iqBuffer: Buffer): void {
    if (!this.running) return;

    const { modulation } = this.config.device;
    let pcm: Buffer | undefined;

    switch (modulation.toLowerCase()) {
      case "wbfm":
      case "nbfm":
        pcm = this._demodFM(iqBuffer);
        break;
      case "am":
        pcm = this._demodAM(iqBuffer);
        break;
      default:
        console.error(`Unknown modulation: ${modulation}. Use: wbfm, nbfm, am`);
        return;
    }

    if (pcm && pcm.length > 0 && this.ffmpeg && this.ffmpeg.stdin!.writable) {
      this.ffmpeg.stdin!.write(pcm);
    }
  }

  stop(): void {
    this.running = false;
    if (this.ffmpeg) {
      try { this.ffmpeg.stdin!.end(); } catch (_) {}
      try { this.ffmpeg.kill("SIGTERM"); } catch (_) {}
      this.ffmpeg = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FM discriminator (arctangent method — works for both WBFM and NBFM)
  //
  // Instantaneous frequency = d(phase)/dt
  //   = atan2(Q[n]·I[n-1] − I[n]·Q[n-1],
  //           I[n]·I[n-1] + Q[n]·Q[n-1])
  //
  // For WBFM: deviation ≈ 75 kHz, audio bandwidth 15 kHz
  // For NBFM: deviation ≈ 5 kHz,  audio bandwidth 3 kHz
  // Both use the same discriminator — NBFM just sounds narrower naturally.
  // ─────────────────────────────────────────────────────────────────────────
  private _demodFM(buf: Buffer): Buffer {
    const numSamples = Math.floor(buf.length / 2);
    const out = Buffer.allocUnsafe(Math.ceil(numSamples / this._decimFactor) * 2);
    let outIdx = 0;

    for (let i = 0; i < numSamples; i++) {
      // Normalise u8 → float [-1, +1]
      const iSample = (buf[i * 2]     - 128) * (1 / 128);
      const qSample = (buf[i * 2 + 1] - 128) * (1 / 128);

      // Phase difference between this sample and the previous
      const cross = qSample * this._prevI - iSample * this._prevQ;
      const dot   = iSample * this._prevI + qSample * this._prevQ;
      let demod   = Math.atan2(cross, dot); // range: −π … +π

      this._prevI = iSample;
      this._prevQ = qSample;

      // Decimate
      this._decimCounter++;
      if (this._decimCounter < this._decimFactor) continue;
      this._decimCounter = 0;

      // Normalise −π…+π → −1…+1
      demod /= Math.PI;

      // DC blocker (first-order IIR high-pass, corner ~20 Hz)
      // y[n] = x[n] - x[n-1] + 0.9995 * y[n-1]
      const dcBlocked = demod - this._dcPrevIn + 0.9995 * this._dcPrev;
      this._dcPrevIn = demod;
      this._dcPrev = dcBlocked;

      // Scale to s16 with headroom
      const s16 = Math.max(-32767, Math.min(32767, dcBlocked * 0.8 * 32767));
      out.writeInt16LE(Math.round(s16), outIdx * 2);
      outIdx++;
    }

    return out.slice(0, outIdx * 2);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AM demodulator: envelope detection
  // Magnitude of complex signal = sqrt(I² + Q²), then remove DC carrier
  // ─────────────────────────────────────────────────────────────────────────
  private _demodAM(buf: Buffer): Buffer {
    const numSamples = Math.floor(buf.length / 2);
    const out = Buffer.allocUnsafe(Math.ceil(numSamples / this._decimFactor) * 2);
    let outIdx = 0;

    for (let i = 0; i < numSamples; i++) {
      const iSample = (buf[i * 2]     - 128) * (1 / 128);
      const qSample = (buf[i * 2 + 1] - 128) * (1 / 128);
      const mag = Math.sqrt(iSample * iSample + qSample * qSample);

      this._decimCounter++;
      if (this._decimCounter < this._decimFactor) continue;
      this._decimCounter = 0;

      // Slow-tracking DC removal (removes the carrier level)
      this._amDc = 0.999 * this._amDc + 0.001 * mag;
      const audio = (mag - this._amDc) * 2.0;

      const s16 = Math.max(-32767, Math.min(32767, audio * 32767));
      out.writeInt16LE(Math.round(s16), outIdx * 2);
      outIdx++;
    }

    return out.slice(0, outIdx * 2);
  }
}

export default DspPipeline;
