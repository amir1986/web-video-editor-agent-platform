import { apiFetch, getApiBase } from "./utils/api-client";

async function fetchVideoBlob(videoUrl: string): Promise<Blob> {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Failed to load video (${res.status})`);
  const blob = await res.blob();
  if (blob.size === 0) throw new Error("Video file is empty — please re-import the video");
  return blob;
}

export async function exportTrimmed(
  videoUrl: string,
  inSec: number,
  outSec: number,
  filename: string,
  onProgress: (p: number) => void,
  apiBase: string = getApiBase()
): Promise<void> {
  onProgress(10);
  const videoBlob = await fetchVideoBlob(videoUrl);
  onProgress(30);

  const name = encodeURIComponent(filename.replace(".mp4", ""));
  const res = await apiFetch(
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
  editPlan: object,
  apiBase: string = getApiBase()
): Promise<void> {
  onProgress(10);
  const videoBlob = await fetchVideoBlob(videoUrl);
  onProgress(30);

  const name = encodeURIComponent(filename.replace(".mp4", ""));
  const editPlanParam = encodeURIComponent(JSON.stringify(editPlan));
  const res = await apiFetch(
    `${apiBase}/api/render?name=${name}&editPlan=${editPlanParam}`,
    {
      method: "POST",
      body: videoBlob,
      headers: { "Content-Type": "video/mp4" },
    }
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
