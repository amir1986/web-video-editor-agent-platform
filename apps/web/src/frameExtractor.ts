export async function extractFrames(video: HTMLVideoElement, count = 5): Promise<string[]> {
  const duration = video.duration;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 144;
  const ctx = canvas.getContext("2d")!;
  const frames: string[] = [];
  const original = video.currentTime;

  for (let i = 0; i < count; i++) {
    const t = (duration / (count - 1)) * i;
    await new Promise<void>((resolve) => {
      video.currentTime = t;
      video.onseeked = () => {
        ctx.drawImage(video, 0, 0, 256, 144);
        frames.push(canvas.toDataURL("image/jpeg", 0.5));
        resolve();
      };
    });
  }

  video.currentTime = original;
  return frames;
}
