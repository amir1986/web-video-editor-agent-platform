import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<void> | null = null;

export function preloadFFmpeg(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: await toBlobURL("/ffmpeg/ffmpeg-core.js", "text/javascript"),
      wasmURL: await toBlobURL("/ffmpeg/ffmpeg-core.wasm", "application/wasm"),
      workerURL: await toBlobURL("/ffmpeg/ffmpeg-core.worker.js", "text/javascript"),
    });
  })();
  return loadPromise;
}

export async function exportTrimmed(
  videoUrl: string,
  inSec: number,
  outSec: number,
  filename: string,
  onProgress: (p: number) => void
): Promise<void> {
  onProgress(5);
  await preloadFFmpeg();
  onProgress(15);

  ffmpeg!.on("progress", ({ progress }) => onProgress(15 + Math.round(progress * 80)));

  await ffmpeg!.writeFile("input.mp4", await fetchFile(videoUrl));
  onProgress(25);

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
