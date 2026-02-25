import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;
let loaded = false;

export async function preloadFFmpeg(): Promise<void> {
  if (loaded) return;
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL("/ffmpeg/ffmpeg-core.js", "text/javascript"),
    wasmURL: await toBlobURL("/ffmpeg/ffmpeg-core.wasm", "application/wasm"),
  });
  loaded = true;
}

export async function exportTrimmed(
  videoUrl: string,
  inSec: number,
  outSec: number,
  filename: string,
  onProgress: (p: number) => void
): Promise<void> {
  if (!loaded || !ffmpeg) {
    onProgress(5);
    await preloadFFmpeg();
  }

  ffmpeg!.on("progress", ({ progress }) => onProgress(10 + Math.round(progress * 85)));

  onProgress(10);
  await ffmpeg!.writeFile("input.mp4", await fetchFile(videoUrl));
  onProgress(30);

  await ffmpeg!.exec([
    "-ss", String(inSec),
    "-i", "input.mp4",
    "-t", String(outSec - inSec),
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    "output.mp4"
  ]);

  onProgress(95);
  const data = await ffmpeg!.readFile("output.mp4") as Uint8Array;
  const blob = new Blob([data], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  onProgress(100);
}
