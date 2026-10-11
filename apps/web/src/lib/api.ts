const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

export async function fetchJson<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    credentials: "include",
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      payload.detail || payload.message || payload.error || "请求失败",
    );
  }
  return payload;
}
