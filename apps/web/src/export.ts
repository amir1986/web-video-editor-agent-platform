import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;

export async function loadFFmpeg(onProgress: (p: number) => void): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => onProgress(Math.round(progress * 100)));
  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });
  return ffmpeg;
}

export async function exportTrimmed(
  videoUrl: string,
  inSec: number,
  outSec: number,
  filename: string,
  onProgress: (p: number) => void
): Promise<void> {
  const ff = await loadFFmpeg(onProgress);
  await ff.writeFile("input.mp4", await fetchFile(videoUrl));
  await ff.exec([
    "-i", "input.mp4",
    "-ss", String(inSec),
    "-to", String(outSec),
    "-c", "copy",
    "output.mp4"
  ]);
  const data = await ff.readFile("output.mp4");
  const blob = new Blob([data], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
