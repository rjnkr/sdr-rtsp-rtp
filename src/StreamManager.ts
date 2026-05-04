// Wires together SdrClient → DspPipeline → RtspServer for a single SDR device.
// Handles reconnection and restart logic.

import SdrClient from "./SdrClient";
import DspPipeline from "./DspPipeline";
import RtspServer from "./RtspServer";
import RtpClient from "./RtpClient";
import Mp3Recorder from "./Mp3Recorder";
import { DeviceConfig, RtspConfig } from "./types";

class StreamManager {
  private deviceConfig: DeviceConfig;
  private rtspConfig: RtspConfig;
  private sdrClient: SdrClient | null = null;
  private dspPipeline: DspPipeline | null = null;
  private rtspServer: RtspServer | null = null;
  private rtpServer: RtpClient | null = null;
  private mp3Recorder: Mp3Recorder | null = null;

  constructor(deviceConfig: DeviceConfig, rtspConfig: RtspConfig) {
    this.deviceConfig = deviceConfig;
    this.rtspConfig   = rtspConfig;
  }

  start(): void {
    const { label, id } = this.deviceConfig;
    console.log(`\n[${label}] ─── Starting stream pipeline ───`);

    // 1. RTSP publisher (starts listening before data arrives)
    this.rtspServer = new RtspServer(this.deviceConfig, this.rtspConfig);
    this.rtspServer.start();

    this.rtspServer.on("close", () => {
      console.warn(`[${label}] RTSP server closed — restarting in 2s`);
      setTimeout(() => this._restartRtsp(), 2000);
    });

    // 2. RTP client (optional — only if rtpOutput is configured)
    if (this.deviceConfig.rtpOutput) {
      this.rtpServer = new RtpClient(this.deviceConfig, this.deviceConfig.rtpOutput);
      this.rtpServer.start();
      this.rtpServer.on("close", () => {
        console.warn(`[${label}] RTP client closed — restarting in 2s`);
        setTimeout(() => this._restartRtp(), 2000);
      });
      this.rtpServer.on("error", (err: Error) => {
        console.error(`[${label}] RTP client error: ${err.message}`);
      });
    }

    // 3. MP3 recorder (optional — only if recording is configured and enabled)
    const rec = this.deviceConfig.recording;
    if (rec && rec.enabled) {
      this.mp3Recorder = new Mp3Recorder(this.deviceConfig, rec);
      this.mp3Recorder.start();
      this.mp3Recorder.on("error", (err: Error) => {
        console.error(`[${label}] Recorder error: ${err.message}`);
      });
    }

    // 4. DSP pipeline
    this.dspPipeline = new DspPipeline(this.deviceConfig);
    this.dspPipeline.start();

    // PCM output → RTSP + RTP publishers + recorder
    this.dspPipeline.on("pcm", (pcm: Buffer) => {
      this.rtspServer!.writePcm(pcm);
      if (this.rtpServer)   this.rtpServer.writePcm(pcm);
      if (this.mp3Recorder) this.mp3Recorder.writePcm(pcm);
    });

    this.dspPipeline.on("close", () => {
      console.warn(`[${label}] DSP pipeline closed — restarting in 2s`);
      setTimeout(() => this._restartDsp(), 2000);
    });

    // 5. SDR client
    this.sdrClient = new SdrClient(this.deviceConfig);

    // IQ data → DSP pipeline
    this.sdrClient.on("data", (iq: Buffer) => {
      this.dspPipeline!.write(iq);
    });

    this.sdrClient.on("connected", () => {
      const { frequency, modulation } = this.deviceConfig;
      const { port } = this.rtspConfig;
      console.log(`[${label}] ✓ Stream active`);
      console.log(`[${label}]   Frequency : ${(frequency / 1e6).toFixed(3)} MHz (${modulation.toUpperCase()})`);
      console.log(`[${label}]   RTSP URL  : rtsp://<server-ip>:${port}/${id}`);
    });

    this.sdrClient.on("disconnected", () => {
      console.error(`[${label}] SDR connection lost — shutting down`);
      this.stop();
      process.exit(1);
    });

    this.sdrClient.connect();
  }

  stop(): void {
    if (this.sdrClient)   this.sdrClient.destroy();
    if (this.dspPipeline) this.dspPipeline.stop();
    if (this.rtspServer)  this.rtspServer.stop();
    if (this.rtpServer)   this.rtpServer.stop();
    if (this.mp3Recorder) this.mp3Recorder.stop();
  }

  private _restartDsp(): void {
    if (this.dspPipeline) this.dspPipeline.stop();
    this.dspPipeline = new DspPipeline(this.deviceConfig);
    this.dspPipeline.start();
    this.dspPipeline.on("pcm", (pcm: Buffer) => {
      this.rtspServer!.writePcm(pcm);
      if (this.rtpServer)   this.rtpServer.writePcm(pcm);
      if (this.mp3Recorder) this.mp3Recorder.writePcm(pcm);
    });
    this.dspPipeline.on("close", () => {
      setTimeout(() => this._restartDsp(), 2000);
    });
  }

  private _restartRtsp(): void {
    if (this.rtspServer) this.rtspServer.stop();
    this.rtspServer = new RtspServer(this.deviceConfig, this.rtspConfig);
    this.rtspServer.start();
    this.rtspServer.on("close", () => { setTimeout(() => this._restartRtsp(), 2000); });
  }

  private _restartRtp(): void {
    if (!this.deviceConfig.rtpOutput) return;
    if (this.rtpServer) this.rtpServer.stop();
    this.rtpServer = new RtpClient(this.deviceConfig, this.deviceConfig.rtpOutput);
    this.rtpServer.start();
    this.rtpServer.on("close", () => { setTimeout(() => this._restartRtp(), 2000); });
    this.rtpServer.on("error", (err: Error) => {
      console.error(`[${this.deviceConfig.label}] RTP client error: ${err.message}`);
    });
  }
}

export default StreamManager;
