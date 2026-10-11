import { englishMessage } from "./messages";

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
      englishMessage(payload.detail || payload.message || payload.error),
    );
  }
  return payload;
}

// JSON lines can span transport chunks, including the bytes of a UTF-8 character.
export async function streamAnswer(
  body: unknown,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/answer/stream`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      englishMessage(payload.detail || payload.message || payload.error),
    );
  }
  if (!response.body) throw new Error("The answer stream is empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  let completed = false;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(englishMessage(event.message));
    if (event.type === "delta" && typeof event.text === "string") {
      text += event.text;
      onText(text);
    } else if (event.type === "done") completed = true;
    else throw new Error("The answer stream contained an invalid event.");
  }
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        consume(line);
        if (completed) break;
      }
      if (done) {
        if (!completed && pending.trim()) consume(pending);
        break;
      }
    }
    if (!completed)
      throw new Error(
        "The answer stream ended unexpectedly. Please try again.",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
