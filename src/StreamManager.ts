// Wires together SdrClient → DspPipeline → RtspServer for a single SDR device.
// Handles reconnection and restart logic.

import SdrClient from "./SdrClient";
import DspPipeline from "./DspPipeline";
import RtspServer from "./RtspServer";
import RtpClient from "./RtpClient";
import Mp3Recorder from "./Mp3Recorder";
import { AppConfig } from "./types";

class StreamManager {
  private config: AppConfig;
  private sdrClient: SdrClient | null = null;
  private dspPipeline: DspPipeline | null = null;
  private rtspServer: RtspServer | null = null;
  private rtpClient: RtpClient | null = null;
  private mp3Recorder: Mp3Recorder | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  start(): void {
    const { id } = this.config.device;
    console.log(`\n─── Starting stream pipeline ───`);

    // 1. RTSP publisher (starts listening before data arrives)
    this.rtspServer = new RtspServer(this.config);
    this.rtspServer.start();

    this.rtspServer.on("close", () => {
      console.warn(`RTSP server closed — restarting in 2s`);
      setTimeout(() => this._restartRtsp(), 2000);
    });

    // 2. RTP client (optional — only if rtpOutput is configured)
    if (this.config.device.rtpOutput) {
      this.rtpClient = new RtpClient(this.config);
      this.rtpClient.start();
      this.rtpClient.on("close", () => {
        console.warn(`RTP client closed — restarting in 2s`);
        setTimeout(() => this._restartRtp(), 2000);
      });
      this.rtpClient.on("error", (err: Error) => {
        console.error(`RTP client error: ${err.message}`);
      });
    }

    // 3. MP3 recorder (optional — only if recording is configured and enabled)
    const rec = this.config.device.recording;
    if (rec && rec.enabled) {
      this.mp3Recorder = new Mp3Recorder(this.config);
      this.mp3Recorder.start();
      this.mp3Recorder.on("error", (err: Error) => {
        console.error(`Recorder error: ${err.message}`);
      });
    }

    // 4. DSP pipeline
    this.dspPipeline = new DspPipeline(this.config);
    this.dspPipeline.start();

    // PCM output → RTSP + RTP publishers + recorder
    this.dspPipeline.on("pcm", (pcm: Buffer) => {
      this.rtspServer!.writePcm(pcm);
      if (this.rtpClient)   this.rtpClient.writePcm(pcm);
      if (this.mp3Recorder) this.mp3Recorder.writePcm(pcm);
    });

    this.dspPipeline.on("close", () => {
      console.warn(`DSP pipeline closed — restarting in 2s`);
      setTimeout(() => this._restartDsp(), 2000);
    });

    // 5. SDR client
    this.sdrClient = new SdrClient(this.config);

    // IQ data → DSP pipeline
    this.sdrClient.on("data", (iq: Buffer) => {
      this.dspPipeline!.write(iq);
    });

    this.sdrClient.on("connected", () => {
      const { frequency, modulation } = this.config.device;
      const { port } = this.config.rtsp;
      console.log(`✓ Stream active`);
      console.log(`  Frequency : ${(frequency / 1e6).toFixed(3)} MHz (${modulation.toUpperCase()})`);
      console.log(`  RTSP URL  : rtsp://<server-ip>:${port}/${id}`);
    });

    this.sdrClient.on("disconnected", () => {
      console.error(`SDR connection lost — shutting down`);
      this.stop();
      process.exit(1);
    });

    this.sdrClient.connect();
  }

  stop(): void {
    if (this.sdrClient)   this.sdrClient.destroy();
    if (this.dspPipeline) this.dspPipeline.stop();
    if (this.rtspServer)  this.rtspServer.stop();
    if (this.rtpClient)   this.rtpClient.stop();
    if (this.mp3Recorder) this.mp3Recorder.stop();
  }

  private _restartDsp(): void {
    if (this.dspPipeline) this.dspPipeline.stop();
    this.dspPipeline = new DspPipeline(this.config);
    this.dspPipeline.start();
    this.dspPipeline.on("pcm", (pcm: Buffer) => {
      this.rtspServer!.writePcm(pcm);
      if (this.rtpClient)   this.rtpClient.writePcm(pcm);
      if (this.mp3Recorder) this.mp3Recorder.writePcm(pcm);
    });
    this.dspPipeline.on("close", () => {
      setTimeout(() => this._restartDsp(), 2000);
    });
  }

  private _restartRtsp(): void {
    if (this.rtspServer) this.rtspServer.stop();
    this.rtspServer = new RtspServer(this.config);
    this.rtspServer.start();
    this.rtspServer.on("close", () => { setTimeout(() => this._restartRtsp(), 2000); });
  }

  private _restartRtp(): void {
    if (!this.config.device.rtpOutput) return;
    if (this.rtpClient) this.rtpClient.stop();
    this.rtpClient = new RtpClient(this.config);
    this.rtpClient.start();
    this.rtpClient.on("close", () => { setTimeout(() => this._restartRtp(), 2000); });
    this.rtpClient.on("error", (err: Error) => {
      console.error(`RTP client error: ${err.message}`);
    });
  }
}

export default StreamManager;