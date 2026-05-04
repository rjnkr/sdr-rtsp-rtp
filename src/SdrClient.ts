// Connects to an rtl_tcp server and controls it (frequency, gain, sample rate)
// Emits raw IQ data as a readable stream for downstream DSP

import net from "net";
import { EventEmitter } from "events";
import { DeviceConfig } from "./types";

// rtl_tcp command codes
const CMD = {
  SET_FREQUENCY:   0x01,
  SET_SAMPLE_RATE: 0x02,
  SET_GAIN_MODE:   0x03,  // 0=auto, 1=manual
  SET_GAIN:        0x04,  // gain in tenths of dB
  SET_PPM:         0x05,
  SET_AGC_MODE:    0x08,
} as const;

class SdrClient extends EventEmitter {
  private config: DeviceConfig;
  private socket: net.Socket | null = null;
  private connected = false;
  private everConnected = false;   // true once the first successful connection is made
  private readonly reconnectDelay = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(config: DeviceConfig) {
    super();
    this.config = config;
  }

  connect(): void {
    if (this.destroyed) return;

    const { rtlTcpHost, rtlTcpPort, label } = this.config;
    console.log(`[${label}] Connecting to rtl_tcp at ${rtlTcpHost}:${rtlTcpPort}...`);

    this.socket = new net.Socket();
    this.socket.setNoDelay(true);

    this.socket.connect(rtlTcpPort, rtlTcpHost, () => {
      console.log(`[${label}] Connected to rtl_tcp`);
      this.connected = true;
      this.everConnected = true;
      this._applySettings();
      this.emit("connected");
    });

    // rtl_tcp sends a 12-byte magic header: "RTL0" + dongle type (4 bytes) + tuner gain count (4 bytes)
    let headerReceived = false;
    let headerBuffer = Buffer.alloc(0);

    this.socket.on("data", (chunk: Buffer) => {
      if (!headerReceived) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        if (headerBuffer.length >= 12) {
          const magic = headerBuffer.slice(0, 4).toString("ascii");
          if (magic === "RTL0") {
            console.log(`[${label}] rtl_tcp handshake OK`);
            headerReceived = true;
            // Emit any IQ data that came with the header packet
            if (headerBuffer.length > 12) {
              this.emit("data", headerBuffer.slice(12));
            }
          } else {
            console.error(`[${label}] Unexpected magic: ${magic}`);
            this.socket!.destroy();
          }
        }
        return;
      }
      this.emit("data", chunk);
    });

    this.socket.on("error", (err: Error) => {
      console.error(`[${label}] Socket error: ${err.message}`);
      this.connected = false;
      this.emit("error", err);
    });

    this.socket.on("close", () => {
      this.connected = false;
      if (this.everConnected) {
        // A live connection was lost — let the caller decide (StreamManager will exit)
        console.warn(`[${label}] Connection lost`);
        this.emit("disconnected");
      } else {
        // Never connected yet — keep retrying silently until it succeeds
        this._scheduleReconnect();
      }
    });
  }

  private _scheduleReconnect(): void {
    if (this.destroyed) return;
    const { label, rtlTcpHost, rtlTcpPort } = this.config;
    console.log(`[${label}] rtl_tcp not reachable (${rtlTcpHost}:${rtlTcpPort}) — retrying in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
  }

  private _sendCommand(cmd: number, value: number): void {
    if (!this.socket || !this.connected) return;
    const buf = Buffer.alloc(5);
    buf.writeUInt8(cmd, 0);
    buf.writeUInt32BE(value >>> 0, 1);  // unsigned 32-bit big-endian
    this.socket.write(buf);
  }

  private _applySettings(): void {
    const { frequency, sampleRate, gain, ppmCorrection, label } = this.config;

    console.log(`[${label}] Setting frequency: ${(frequency / 1e6).toFixed(3)} MHz`);
    this._sendCommand(CMD.SET_FREQUENCY, frequency);

    console.log(`[${label}] Setting sample rate: ${(sampleRate / 1e6).toFixed(2)} MSPS`);
    this._sendCommand(CMD.SET_SAMPLE_RATE, sampleRate);

    if (gain === 0) {
      console.log(`[${label}] Gain: auto`);
      this._sendCommand(CMD.SET_GAIN_MODE, 0); // auto
      this._sendCommand(CMD.SET_AGC_MODE, 1);
    } else {
      console.log(`[${label}] Gain: ${gain} dB`);
      this._sendCommand(CMD.SET_GAIN_MODE, 1);       // manual
      this._sendCommand(CMD.SET_GAIN, gain * 10);    // tenths of dB
      this._sendCommand(CMD.SET_AGC_MODE, 0);
    }

    if (ppmCorrection !== 0) {
      console.log(`[${label}] PPM correction: ${ppmCorrection}`);
      this._sendCommand(CMD.SET_PPM, ppmCorrection);
    }
  }

  // Retune on-the-fly without reconnecting
  setFrequency(hz: number): void {
    this.config.frequency = hz;
    console.log(`[${this.config.label}] Retuning to ${(hz / 1e6).toFixed(3)} MHz`);
    this._sendCommand(CMD.SET_FREQUENCY, hz);
  }

  setGain(db: number): void {
    this.config.gain = db;
    if (db === 0) {
      this._sendCommand(CMD.SET_GAIN_MODE, 0);
      this._sendCommand(CMD.SET_AGC_MODE, 1);
    } else {
      this._sendCommand(CMD.SET_GAIN_MODE, 1);
      this._sendCommand(CMD.SET_GAIN, db * 10);
      this._sendCommand(CMD.SET_AGC_MODE, 0);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.destroy();
  }
}

export default SdrClient;
