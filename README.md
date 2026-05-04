# SDR → RTSP Streaming Server

Connects to one or more `rtl_tcp` instances (Raspberry Pi + RTL-SDR dongles) and
re-serves the demodulated audio as RTSP streams that any RTSP client (VLC, ffplay, etc.) can play.

```
Raspberry Pi                     This machine                    Your VLC / ffplay
┌─────────────┐    TCP :1234    ┌─────────────────┐   RTSP :8554  ┌────────────┐
│  rtl_tcp    │ ──────────────▶ │  sdr-rtsp-server│ ────────────▶ │  VLC       │
│  RTL-SDR    │                 │  (Node.js)       │               │  ffplay    │
└─────────────┘                 └─────────────────┘               └────────────┘
                                  IQ→FFmpeg→PCM→AAC
```

---

## Prerequisites

### On the machine running this server

1. **Node.js** ≥ 18  
   ```bash
   node --version
   ```

2. **FFmpeg** (does all the DSP and RTSP serving)  
   ```bash
   # Debian / Ubuntu / Raspberry Pi OS
   sudo apt install ffmpeg

   # macOS
   brew install ffmpeg

   # Windows
   # Download from https://ffmpeg.org/download.html and add to PATH
   ```

### On the Raspberry Pi

`rtl_tcp` must be running and reachable. Start it with:
```bash
rtl_tcp -a 0.0.0.0 -p 1234
```
Or to auto-start on boot, add a systemd service (see below).

---

## Installation

```bash
git clone <this-repo>
cd sdr-rtsp
npm install
```

---

## Configuration

Edit **`config.js`** — everything is in one place:

```js
module.exports = {
  rtsp: {
    port: 8554,           // RTSP server port
  },
  devices: [
    {
      id: "sdr1",                      // → rtsp://<host>:8554/sdr1
      label: "SDR Device 1",
      rtlTcpHost: "raspberrypi.local", // or IP address
      rtlTcpPort: 1234,
      frequency: 100300000,            // 100.3 MHz
      sampleRate: 2400000,             // 2.4 MSPS
      gain: 40,                        // dB, 0 = auto
      ppmCorrection: 0,
      modulation: "wbfm",              // wbfm | nbfm | am
      audioSampleRate: 44100,
      stereo: true,
      enabled: true,
    },
  ],
};
```

### Adding a second device

Just add another object to the `devices` array:

```js
{
  id: "sdr2",
  label: "SDR Device 2",
  rtlTcpHost: "192.168.1.101",   // second Pi
  rtlTcpPort: 1234,
  frequency: 162400000,          // NOAA Weather Radio
  sampleRate: 2400000,
  gain: 35,
  ppmCorrection: 0,
  modulation: "nbfm",
  audioSampleRate: 44100,
  stereo: false,
  enabled: true,
}
```

---

## Running

```bash
node src/index.js
```

You'll see output like:
```
╔══════════════════════════════════════════════════════╗
║          SDR → RTSP Streaming Server                 ║
╚══════════════════════════════════════════════════════╝
  RTSP port : 8554
  Devices   : 1 enabled

✓ FFmpeg found

[SDR Device 1] ─── Starting stream pipeline ───
[SDR Device 1] Connecting to rtl_tcp at raspberrypi.local:1234...
[SDR Device 1] Connected to rtl_tcp
[SDR Device 1] Setting frequency: 100.300 MHz
[SDR Device 1] ✓ Stream active
[SDR Device 1]   RTSP URL : rtsp://<server-ip>:8554/sdr1
```

---

## Connecting with VLC

1. Open VLC → **Media → Open Network Stream**
2. Enter: `rtsp://192.168.1.100:8554/sdr1`  ← replace with your server's IP
3. Click **Play**

Or from the command line:
```bash
vlc rtsp://192.168.1.100:8554/sdr1
# or
ffplay rtsp://192.168.1.100:8554/sdr1
```

---

## Modulation types

| Value  | Use case                                     |
|--------|----------------------------------------------|
| `wbfm` | Broadcast FM radio (88–108 MHz)              |
| `nbfm` | Emergency services, aviation, ham radio      |
| `am`   | AM broadcast, aviation voice (118–137 MHz)   |

---

## PPM Correction

If the audio sounds slightly off-frequency, your dongle may need PPM calibration.
Use `rtl_test -p` on the Pi to measure the error, then set `ppmCorrection` in config.

---

## Running as a service (systemd)

```ini
# /etc/systemd/system/sdr-rtsp.service
[Unit]
Description=SDR RTSP Streaming Server
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/sdr-rtsp/src/index.js
WorkingDirectory=/path/to/sdr-rtsp
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable sdr-rtsp
sudo systemctl start sdr-rtsp
```

---

## Raspberry Pi: auto-start rtl_tcp

```ini
# /etc/systemd/system/rtl-tcp.service
[Unit]
Description=RTL-SDR TCP Server
After=network.target

[Service]
ExecStart=/usr/bin/rtl_tcp -a 0.0.0.0 -p 1234
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable rtl-tcp
sudo systemctl start rtl-tcp
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `FFmpeg not found` | `sudo apt install ffmpeg` |
| `Connection refused :1234` | Check `rtl_tcp` is running on the Pi and firewall allows port 1234 |
| Audio is silent | Increase `gain` in config (try 40–50 dB), check frequency |
| Audio sounds distorted | Lower `gain`, or try `gain: 0` for auto |
| Stream not found in VLC | Check firewall allows port 8554, use exact IP not hostname |
| Frequency offset | Set `ppmCorrection` — use `rtl_test -p` on the Pi to measure |
