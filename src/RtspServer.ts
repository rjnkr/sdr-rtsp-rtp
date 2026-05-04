// A minimal Node.js RTSP/1.0 server (RFC 2326) that serves a live audio stream.
//
// Architecture:
//   DspPipeline (s16le PCM)
//     → FFmpeg encoder process (AAC → MPEG-TS over stdout)
//       → Node.js TCP server (RTSP handshake + RTP/TCP interleaved delivery)
//         → VLC / any RTSP client
//
// RTSP flow:
//   Client → OPTIONS   → 200 OK
//   Client → DESCRIBE  → 200 OK + SDP
//   Client → SETUP     → 200 OK + session/transport
//   Client → PLAY      → 200 OK  ← client is now "connected" and receiving audio
//   Client → TEARDOWN  → 200 OK  ← client disconnected
//
// Audio is delivered as RTP packets over the same TCP connection (interleaved),
// framed as:  $ | channel(1) | length(2) | RTP packet

import net from "net";
import dgram from "dgram";
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import crypto from "crypto";
import { AppConfig } from "./types";

// RTP timestamp increment per AAC frame (1024 samples at 44100 Hz ≈ 23ms)
const AAC_SAMPLES_PER_FRAME = 1024;

const SAMPLE_RATE_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

interface ClientState {
  addr: string;
  session: string;
  transport: "tcp" | "udp" | null;
  channel: number;
  udpSocket: dgram.Socket | null;
  udpAddress: string | null;
  udpRtpPort: number;
  playing: boolean;
  buffer: string;
}

class RtspServer extends EventEmitter {
  private config: AppConfig;
  private tcpServer: net.Server | null = null;
  private ffmpeg: ChildProcess | null = null;
  private clients = new Map<net.Socket, ClientState>();
  private running = false;
  private aacBuffer = Buffer.alloc(0);
  private rtpSeq = 0;
  private rtpTimestamp = 0;
  private readonly ssrc: number;

  constructor(config: AppConfig) {
    super();
    this.config = config;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
  }

  get publicUrl(): string {
    const { port } = this.config.rtsp;
    const { id } = this.config.device;
    return `rtsp://<server-ip>:${port}/${id}`;
  }

  start(): void {
    const { audioSampleRate, label, id } = this.config.device;
    const { port, host } = this.config.rtsp;

    // ── 1. FFmpeg: encode PCM → raw AAC (ADTS framing so we can split frames) ──
    const outputChannels = (this.config.device.modulation === "wbfm" && this.config.device.stereo) ? 2 : 1;

    const ffmpegArgs = [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(audioSampleRate), "-ac", String(outputChannels),
      "-i", "pipe:0",
      "-c:a", "aac", "-b:a", "128k", "-ar", String(audioSampleRate),
      "-f", "adts",   // ADTS = raw AAC with frame headers — easy to parse
      "pipe:1",
    ];

    this.ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

    this.ffmpeg.stdout!.on("data", (chunk: Buffer) => this._onAacData(chunk));
    this.ffmpeg.stderr!.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[${label}] Encoder: ${msg}`);
    });
    this.ffmpeg.on("error", (err: NodeJS.ErrnoException) => {
      console.error(`[${label}] FFmpeg error: ${err.message}`);
      if (err.code === "ENOENT") console.error("  → FFmpeg not found. Install ffmpeg and add it to PATH.");
    });
    this.ffmpeg.on("close", (code: number | null) => {
      console.warn(`[${label}] FFmpeg encoder exited (code ${code})`);
      this.emit("close", code);
    });

    // ── 2. TCP server: handles RTSP handshake and RTP delivery ──────────────
    this.tcpServer = net.createServer((socket) => this._onClientSocket(socket));

    this.tcpServer.listen(port, host, () => {
      this.running = true;
      console.log(`[${label}] RTSP server listening → rtsp://0.0.0.0:${port}/${id}`);
      console.log(`[${label}]   Connect with VLC: rtsp://<server-ip>:${port}/${id}`);
    });

    this.tcpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[${label}] Port ${port} already in use. Change rtsp.port in config.json`);
      } else {
        console.error(`[${label}] TCP server error: ${err.message}`);
      }
      this.emit("error", err);
    });
  }

  // ── Receive PCM from DspPipeline ────────────────────────────────────────
  writePcm(pcmData: Buffer): void {
    if (this.ffmpeg && this.ffmpeg.stdin!.writable) {
      this.ffmpeg.stdin!.write(pcmData);
    }
  }

  stop(): void {
    this.running = false;
    for (const [socket, client] of this.clients) {
      if (client.udpSocket) { try { client.udpSocket.close(); } catch (_) {} }
      try { socket.destroy(); } catch (_) {}
    }
    this.clients.clear();
    if (this.tcpServer) { try { this.tcpServer.close(); } catch (_) {} }
    if (this.ffmpeg) {
      try { this.ffmpeg.stdin!.end(); } catch (_) {}
      try { this.ffmpeg.kill("SIGTERM"); } catch (_) {}
    }
  }

  // ── New TCP connection ───────────────────────────────────────────────────
  private _onClientSocket(socket: net.Socket): void {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    const { label } = this.config.device;

    const client: ClientState = {
      addr,
      session:    crypto.randomBytes(4).toString("hex"),
      transport:  null,
      channel:    0,
      udpSocket:  null,
      udpAddress: null,
      udpRtpPort: 0,
      playing:    false,
      buffer:     "",
    };

    this.clients.set(socket, client);

    socket.on("data", (data: Buffer) => {
      client.buffer += data.toString("binary");
      this._processRtspMessages(socket, client);
    });

    socket.on("close", () => {
      const wasPlaying = client.playing;
      if (client.udpSocket) { try { client.udpSocket.close(); } catch (_) {} }
      this.clients.delete(socket);
      if (wasPlaying) {
        const remaining = this._playingCount();
        console.log(`[${label}] ✗ Client disconnected: ${addr}  (${remaining} listener${remaining !== 1 ? "s" : ""} remaining)`);
        this.emit("clientDisconnected", { addr, remaining });
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      // ECONNRESET is normal (client closed without TEARDOWN)
      if (err.code !== "ECONNRESET") {
        console.error(`[${label}] Client socket error (${addr}): ${err.message}`);
      }
    });
  }

  // ── Parse and respond to RTSP messages ─────────────────────────────────
  private _processRtspMessages(socket: net.Socket, client: ClientState): void {
    const { audioSampleRate, label } = this.config.device;
    const outputChannels = (this.config.device.modulation === "wbfm" && this.config.device.stereo) ? 2 : 1;

    // RTSP messages end with \r\n\r\n
    while (true) {
      const end = client.buffer.indexOf("\r\n\r\n");
      if (end === -1) break;

      const raw = client.buffer.slice(0, end + 4);
      client.buffer = client.buffer.slice(end + 4);

      const lines = raw.split("\r\n");
      const requestLine = lines[0];
      const [method] = requestLine.split(" ");
      const cseqLine = lines.find(l => l.toLowerCase().startsWith("cseq:"));
      const cseq = cseqLine ? (cseqLine.split(":")[1]?.trim() ?? "0") : "0";

      switch (method) {
        case "OPTIONS":
          this._send(socket, [
            `RTSP/1.0 200 OK`,
            `CSeq: ${cseq}`,
            `Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN`,
            "", "",
          ]);
          break;

        case "DESCRIBE": {
          // SDP describes the audio stream
          const sdp = [
            "v=0",
            `o=- 0 0 IN IP4 127.0.0.1`,
            `s=SDR Stream: ${this.config.device.label}`,
            `i=${this.config.device.label} — ${(this.config.device.frequency / 1e6).toFixed(3)} MHz ${this.config.device.modulation.toUpperCase()}`,
            "t=0 0",
            "a=tool:sdr-rtsp-server",
            "a=type:broadcast",
            "a=control:*",
            "m=audio 0 RTP/AVP 96",
            `a=rtpmap:96 mpeg4-generic/${audioSampleRate}/${outputChannels}`,
            `a=fmtp:96 streamtype=5; profile-level-id=15; mode=AAC-hbr; sizelength=13; indexlength=3; indexdeltalength=3; config=${this._aacConfig(audioSampleRate, outputChannels)}`,
            "a=control:streamid=0",
            "",
          ].join("\r\n");

          this._send(socket, [
            `RTSP/1.0 200 OK`,
            `CSeq: ${cseq}`,
            `Content-Type: application/sdp`,
            `Content-Length: ${Buffer.byteLength(sdp)}`,
            "",
            sdp,
          ]);
          break;
        }

        case "SETUP": {
          const transportLine = lines.find(l => l.toLowerCase().startsWith("transport:")) ?? "";
          const isTcp = /rtp\/avp\/tcp/i.test(transportLine) || /interleaved=/i.test(transportLine);

          if (isTcp) {
            const m = transportLine.match(/interleaved=(\d+)-(\d+)/);
            client.channel   = m ? parseInt(m[1]) : 0;
            client.transport = "tcp";
            this._send(socket, [
              `RTSP/1.0 200 OK`,
              `CSeq: ${cseq}`,
              `Session: ${client.session};timeout=60`,
              `Transport: RTP/AVP/TCP;unicast;interleaved=${client.channel}-${client.channel + 1}`,
              "", "",
            ]);
          } else {
            // UDP — what ffplay/VLC use by default
            const pm = transportLine.match(/client_port=(\d+)-(\d+)/);
            const clientRtpPort  = pm ? parseInt(pm[1]) : 0;
            const clientRtcpPort = pm ? parseInt(pm[2]) : clientRtpPort + 1;
            client.transport  = "udp";
            client.udpAddress = socket.remoteAddress?.replace(/^::ffff:/, "") ?? null;
            client.udpRtpPort = clientRtpPort;
            const udpSock = dgram.createSocket("udp4");
            udpSock.on("error", (err: Error) => console.error(`[${label}] UDP error: ${err.message}`));
            udpSock.bind(0, () => {
              client.udpSocket = udpSock;
              const serverPort = udpSock.address().port;
              this._send(socket, [
                `RTSP/1.0 200 OK`,
                `CSeq: ${cseq}`,
                `Session: ${client.session};timeout=60`,
                `Transport: RTP/AVP;unicast;client_port=${clientRtpPort}-${clientRtcpPort};server_port=${serverPort}-${serverPort + 1}`,
                "", "",
              ]);
            });
          }
          break;
        }

        case "PLAY": {
          client.playing = true;
          this._send(socket, [
            `RTSP/1.0 200 OK`,
            `CSeq: ${cseq}`,
            `Session: ${client.session}`,
            `Range: npt=0.000-`,
            "", "",
          ]);
          const count = this._playingCount();
          console.log(`[${label}] ✓ Client connected [RTSP]: ${client.addr}  (${count} listener${count !== 1 ? "s" : ""} total)`);
          this.emit("clientConnected", { addr: client.addr, count });
          break;
        }

        case "TEARDOWN": {
          client.playing = false;
          this._send(socket, [
            `RTSP/1.0 200 OK`,
            `CSeq: ${cseq}`,
            `Session: ${client.session}`,
            "", "",
          ]);
          socket.destroy();
          break;
        }

        default:
          this._send(socket, [`RTSP/1.0 405 Method Not Allowed`, `CSeq: ${cseq}`, "", ""]);
      }
    }
  }

  // ── Distribute an AAC/ADTS chunk as RTP packets to all playing clients ──
  private _onAacData(chunk: Buffer): void {
    this.aacBuffer = Buffer.concat([this.aacBuffer, chunk]);

    // Parse ADTS frames and send each as one RTP packet
    let offset = 0;
    while (offset + 7 < this.aacBuffer.length) {
      // ADTS sync word: 0xFFF at start
      if (this.aacBuffer[offset] !== 0xFF || (this.aacBuffer[offset + 1] & 0xF0) !== 0xF0) {
        offset++;
        continue;
      }

      const protectionAbsent = (this.aacBuffer[offset + 1] & 0x01);
      const headerLen = protectionAbsent ? 7 : 9;

      if (offset + headerLen > this.aacBuffer.length) break;

      // Frame length is in bits 30-42 of the header
      const frameLen = ((this.aacBuffer[offset + 3] & 0x03) << 11) |
                       (this.aacBuffer[offset + 4] << 3) |
                       ((this.aacBuffer[offset + 5] & 0xE0) >> 5);

      if (frameLen < headerLen || offset + frameLen > this.aacBuffer.length) break;

      const aacFrame = this.aacBuffer.slice(offset + headerLen, offset + frameLen);
      this._sendRtpPacket(aacFrame);

      this.rtpTimestamp += AAC_SAMPLES_PER_FRAME;
      offset += frameLen;
    }

    this.aacBuffer = this.aacBuffer.slice(offset);
  }

  // ── Build and send one RTP packet (RFC 3640 AAC-hbr) ────────────────────
  private _sendRtpPacket(aacPayload: Buffer): void {
    // RTP header (12 bytes)
    const rtp = Buffer.alloc(12);
    rtp[0] = 0x80;                                        // V=2, P=0, X=0, CC=0
    rtp[1] = 96;                                          // M=0, PT=96 (dynamic)
    rtp.writeUInt16BE(this.rtpSeq & 0xFFFF, 2);
    rtp.writeUInt32BE(this.rtpTimestamp >>> 0, 4);
    rtp.writeUInt32BE(this.ssrc, 8);
    this.rtpSeq++;

    // RFC 3640 AU-Header-Section: 2-byte header size + 2-byte AU header per frame
    const auHeadersLen = Buffer.alloc(2);
    auHeadersLen.writeUInt16BE(16, 0);                    // 16 bits = one 2-byte AU header
    const auHeader = Buffer.alloc(2);
    auHeader.writeUInt16BE((aacPayload.length << 3) & 0xFFFF, 0); // size in top 13 bits

    const rtpPacket = Buffer.concat([rtp, auHeadersLen, auHeader, aacPayload]);

    for (const [socket, client] of this.clients) {
      if (!client.playing || socket.destroyed) continue;
      if (client.transport === "udp" && client.udpSocket && client.udpAddress) {
        try { client.udpSocket.send(rtpPacket, client.udpRtpPort, client.udpAddress); } catch (_) {}
      } else {
        // TCP interleaved framing:  $ | channel | length (2 bytes)
        const frame = Buffer.allocUnsafe(4 + rtpPacket.length);
        frame[0] = 0x24;
        frame[1] = client.channel;
        frame.writeUInt16BE(rtpPacket.length, 2);
        rtpPacket.copy(frame, 4);
        try { socket.write(frame); } catch (_) {}
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private _send(socket: net.Socket, lines: string[]): void {
    if (!socket.destroyed) {
      socket.write(lines.join("\r\n"));
    }
  }

  private _playingCount(): number {
    let n = 0;
    for (const [, c] of this.clients) if (c.playing) n++;
    return n;
  }

  // Compute AudioSpecificConfig hex for the SDP fmtp line
  // 5 bits: audio object type (2=AAC-LC)
  // 4 bits: sample rate index
  // 4 bits: channel config
  private _aacConfig(sampleRate: number, channels: number): string {
    const srIndex = SAMPLE_RATE_TABLE.indexOf(sampleRate);
    const index = srIndex === -1 ? 4 : srIndex; // default to 44100
    const word = (2 << 11) | (index << 7) | (channels << 3);
    return word.toString(16).padStart(4, "0").toUpperCase();
  }
}

export default RtspServer;
