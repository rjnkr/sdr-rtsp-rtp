export interface RtspConfig {
  port: number;
  host: string;
}

export interface RtpOutputConfig {
  host: string;
  port: number;
  rtcpPort?: number;
  threshold?: number;
  holdOffMs?: number;
}

export interface RecordingConfig {
  enabled: boolean;
  outputDir: string;
  splitMinutes: number;
}

export interface DeviceConfig {
  id: string;
  label: string;
  rtlTcpHost: string;
  rtlTcpPort: number;
  frequency: number;
  sampleRate: number;
  gain: number;
  ppmCorrection: number;
  modulation: string;
  audioSampleRate: number;
  stereo: boolean;
  rtpOutput?: RtpOutputConfig;
  recording?: RecordingConfig;
}

export interface AppConfig {
  rtsp: RtspConfig;
  device: DeviceConfig;
}
