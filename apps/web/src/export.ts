import { createFFmpeg, fetchFile } from "@ffmpeg/ffmpeg";

let ffmpeg: any = null;
let loadPromise: Promise<void> | null = null;

export function preloadFFmpeg(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    ffmpeg = createFFmpeg({
      log: false,
      corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
    });
    await ffmpeg.load();
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

  ffmpeg.setProgress(({ ratio }: { ratio: number }) => {
    onProgress(15 + Math.round(ratio * 80));
  });

  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(videoUrl));
  onProgress(25);

  await ffmpeg.run(
    "-ss", String(inSec),
    "-i", "input.mp4",
    "-t", String(outSec - inSec),
    "-c", "copy",
    "output.mp4"
  );

  onProgress(95);
  const data = ffmpeg.FS("readFile", "output.mp4");
  const blob = new Blob([data.buffer], { type: "video/mp4" });
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
