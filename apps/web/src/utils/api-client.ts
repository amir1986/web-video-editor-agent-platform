/**
 * Centralized API client with automatic auth token handling.
 *
 * If AUTH_SECRET is configured on the API side, the web app will obtain
 * a token via /api/auth/login and attach it to every subsequent request.
 * If the API runs in open-access mode the token is simply omitted.
 */

const TOKEN_KEY = "video_editor_auth_token";

let cachedToken: string | null = null;

export function getApiBase(): string {
  return (import.meta as any).env?.VITE_API_URL || "http://localhost:3001";
}

function getStoredToken(): string | null {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = sessionStorage.getItem(TOKEN_KEY);
  } catch { /* SSR / iframe sandbox */ }
  return cachedToken;
}

function storeToken(token: string): void {
  cachedToken = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch { /* ignore */ }
}

/**
 * Obtain an auth token from the API. In open-access mode the API still
 * returns a valid anonymous token, so this always succeeds.
 */
export async function ensureAuthToken(apiBase?: string): Promise<string> {
  const existing = getStoredToken();
  if (existing) return existing;

  const base = apiBase || getApiBase();
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "" }),
  });

  if (res.ok) {
    const data = await res.json();
    if (data.token) {
      storeToken(data.token);
      return data.token;
    }
  }

  // Auth not enabled — proceed without token
  return "";
}

/**
 * Build headers for an API request, including the auth token if available.
 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getStoredToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Wrapper around fetch that auto-attaches auth headers.
 */
export async function apiFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getStoredToken();
  const headers = new Headers(options.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}
