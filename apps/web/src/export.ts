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
  const editPlanJson = JSON.stringify(editPlan);
  console.log(`[EXPORT] Sending editPlan (${editPlanJson.length} chars) to /api/render`);

  // Send editPlan via X-Edit-Plan header instead of query param to avoid
  // URL length limits that silently truncate/lose the editPlan JSON.
  const res = await apiFetch(
    `${apiBase}/api/render?name=${name}`,
    {
      method: "POST",
      body: videoBlob,
      headers: {
        "Content-Type": "video/mp4",
        "X-Edit-Plan": editPlanJson,
      },
    }
  );

  onProgress(80);
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`);

  const blob = await res.blob();
  const segCount = res.headers.get("X-Segments-Count") || "?";
  console.log(`[EXPORT] Received ${(blob.size / 1024 / 1024).toFixed(1)}MB, ${segCount} segments rendered`);
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
  // Revoke after a delay — revoking immediately truncates the download
  // because a.click() starts the save asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function preloadFFmpeg(): Promise<void> {
  return Promise.resolve();
}
