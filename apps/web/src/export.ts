export async function exportTrimmed(
  videoUrl: string,
  inSec: number,
  outSec: number,
  filename: string,
  onProgress: (p: number) => void
): Promise<void> {
  onProgress(10);
  const videoRes = await fetch(videoUrl);
  const videoBlob = await videoRes.blob();
  onProgress(30);

  const res = await fetch(
    `http://localhost:3001/api/trim?in=${inSec}&out=${outSec}&name=${encodeURIComponent(filename.replace(".mp4",""))}`,
    { method: "POST", body: videoBlob, headers: { "Content-Type": "video/mp4" } }
  );

  onProgress(80);
  if (!res.ok) throw new Error(await res.text());

  const blob = await res.blob();
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

export function preloadFFmpeg(): Promise<void> {
  return Promise.resolve();
}
