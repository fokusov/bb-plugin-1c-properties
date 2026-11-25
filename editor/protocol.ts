export const API_BASE = "/api/v1/plugins/1c-properties/http/bsl";

export function createEditorRequest(threadId: string, environmentId: string) {
  return (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set("x-bb-thread-id", threadId);
    headers.set("x-bb-environment-id", environmentId);
    if (options.method === "POST") {
      headers.set("content-type", "application/json");
      return fetch(url, { ...options, headers, body: options.body ?? "{}" });
    }
    return fetch(url, { ...options, headers });
  };
}
