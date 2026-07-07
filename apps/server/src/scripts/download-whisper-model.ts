import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { env, pipeline, type ProgressInfo } from "@huggingface/transformers";

const modelId = process.env.WHISPER_MODEL_ID || "Xenova/whisper-tiny";
const modelsDir = resolve(process.cwd(), process.env.WHISPER_MODEL_DIR || "models");
const remoteHost = normalizeRemoteHost(process.env.HF_ENDPOINT || "https://hf-mirror.com");

await mkdir(modelsDir, { recursive: true });

env.allowLocalModels = true;
env.allowRemoteModels = true;
env.localModelPath = modelsDir;
env.cacheDir = modelsDir;
env.remoteHost = remoteHost;
env.useBrowserCache = false;
env.useFSCache = true;

console.log(`Downloading Whisper model "${modelId}" to ${modelsDir}`);
console.log(`Remote host: ${remoteHost}`);

let lastProgressLoggedAt = 0;
let lastProgressValue = -1;

await pipeline("automatic-speech-recognition", modelId, {
  dtype: "q8",
  cache_dir: modelsDir,
  local_files_only: false,
  progress_callback: reportProgress,
});

console.log(`Whisper model ready: ${modelId}`);

function reportProgress(info: ProgressInfo) {
  if (info.status === "progress_total") {
    const now = Date.now();
    if (info.progress < 100 && now - lastProgressLoggedAt < 500 && info.progress - lastProgressValue < 1) {
      return;
    }
    lastProgressLoggedAt = now;
    lastProgressValue = info.progress;
    process.stdout.write(`\r${formatBytes(info.loaded)} / ${formatBytes(info.total)} (${info.progress.toFixed(1)}%)`);
    if (info.progress >= 100) process.stdout.write("\n");
    return;
  }
  if (info.status === "done") {
    console.log(`Cached ${info.file}`);
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function normalizeRemoteHost(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
