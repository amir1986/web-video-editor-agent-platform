const DEFAULT_API = "http://localhost:3001";

export async function exportTrimmed(
  videoUrl: string,
  inSec: number,
  outSec: number,
  filename: string,
  onProgress: (p: number) => void,
  apiBase: string = DEFAULT_API
): Promise<void> {
  onProgress(10);
  const videoRes = await fetch(videoUrl);
  const videoBlob = await videoRes.blob();
  onProgress(30);

  const name = encodeURIComponent(filename.replace(".mp4", ""));
  const res = await fetch(
    `${apiBase}/api/trim?in=${inSec}&out=${outSec}&name=${name}`,
    { method: "POST", body: videoBlob, headers: { "Content-Type": "video/mp4" } }
  );

  onProgress(80);
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`);

  const blob = await res.blob();
  triggerDownload(blob, filename);
  onProgress(100);
}

export async function exportWithEditPlan(
  videoUrl: string,
  filename: string,
  onProgress: (p: number) => void,
  apiBase: string = DEFAULT_API
): Promise<void> {
  onProgress(10);
  const videoRes = await fetch(videoUrl);
  const videoBlob = await videoRes.blob();
  onProgress(30);

  const name = encodeURIComponent(filename.replace(".mp4", ""));
  const res = await fetch(
    `${apiBase}/api/auto-edit?name=${name}`,
    { method: "POST", body: videoBlob, headers: { "Content-Type": "video/mp4" } }
  );

  onProgress(80);
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`);

  const blob = await res.blob();
  triggerDownload(blob, filename);
  onProgress(100);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function preloadFFmpeg(): Promise<void> {
  return Promise.resolve();
}
