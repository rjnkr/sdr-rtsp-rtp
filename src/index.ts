// SDR → RTSP Streaming Server

import "dotenv/config";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import StreamManager from "./StreamManager";
import type { AppConfig } from "./types";

const configFile = process.env.CONFIG_FILE ?? "config.json";
const config: AppConfig = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), configFile), "utf-8"));

let manager: StreamManager;

function banner(): void {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║          SDR → RTSP Streaming Server & RTP client                ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`  Config    : ${configFile}` + process.env.CONFIG_FILE ? "" : "use CONFIG_FILE env variable to specify a different config file");
  console.log(`  Device    : ${config.device.label}`);
  console.log(`  RTSP port : ${config.rtsp.port}`);
  console.log("");
}

function checkDependencies(): void {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
  } catch {
    console.error("✗ FFmpeg not found. Install it:");
    console.error("    Debian/Ubuntu/Raspberry Pi OS: sudo apt install ffmpeg");
    console.error("    macOS: brew install ffmpeg");
    console.error("    Windows: https://ffmpeg.org/download.html");
    process.exit(1);
  }
  console.log("✓ FFmpeg found");
}

function start(): void {
  banner();
  checkDependencies();

  manager = new StreamManager(config.device, config.rtsp);
  manager.start();

  setTimeout(() => {
    console.log("\n──────────────────────────────────────────────────────");
    console.log("  Connect with VLC:");
    console.log(`    rtsp://<server-ip>:${config.rtsp.port}/${config.device.id}`);
    console.log("  Or via command line:");
    console.log(`    ffplay rtsp://<server-ip>:${config.rtsp.port}/${config.device.id}`);
    console.log("──────────────────────────────────────────────────────\n");
  }, 2000);
}

function shutdown(): void {
  console.log("\nShutting down...");
  manager.stop();
  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
