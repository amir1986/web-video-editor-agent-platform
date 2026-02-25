export async function exportTrimmed(
  videoUrl: string,
  inSec: number,
  outSec: number,
  filename: string,
  onProgress: (p: number) => void
): Promise<void> {
  onProgress(10);

  const response = await fetch(videoUrl);
  const arrayBuffer = await response.arrayBuffer();
  onProgress(40);

  // @ts-ignore
  const MP4Box = (await import("mp4box")).default;
  const mp4boxIn = MP4Box.createFile();
  const mp4boxOut = MP4Box.createFile();

  await new Promise<void>((resolve, reject) => {
    mp4boxIn.onReady = (info: any) => {
      onProgress(60);
      const tracks = info.tracks.map((t: any) => t.id);
      tracks.forEach((id: number) => mp4boxIn.setExtractionOptions(id, null, { nbSamples: Infinity }));

      mp4boxIn.onSamples = (id: number, user: any, samples: any[]) => {
        const filtered = samples.filter(s => {
          const t = s.cts / s.timescale;
          return t >= inSec && t <= outSec;
        });
        filtered.forEach(s => mp4boxOut.addSample(id, s.data, s));
      };

      mp4boxIn.start();
    };

    mp4boxIn.onError = reject;

    const buf = arrayBuffer as any;
    buf.fileStart = 0;
    mp4boxIn.appendBuffer(buf);
    mp4boxIn.flush();

    setTimeout(() => {
      onProgress(85);
      const outBuffer = mp4boxOut.save("");
      const blob = new Blob([outBuffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onProgress(100);
      resolve();
    }, 500);
  });
}

export async function preloadFFmpeg(): Promise<void> {}
