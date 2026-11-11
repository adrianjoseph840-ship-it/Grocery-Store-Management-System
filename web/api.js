/** Small HTTP boundary for browser screens. Every API response should be JSON. */
export async function request(path, options = {}, fetcher = fetch) {
  const headers = new Headers(options.headers);
  if (options.body) {
    headers.set("Content-Type", "application/json");
    if (!headers.has("Idempotency-Key"))
      headers.set("Idempotency-Key", crypto.randomUUID());
  }

  let response;
  try {
    response = await fetcher(`/api${path}`, { ...options, headers });
  } catch {
    throw new Error(
      "Cannot connect to the canteen server. Check that node src/server.js is running.",
    );
  }

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(
      `Server returned an invalid response (HTTP ${response.status}). Refresh and try again.`,
    );
  }
  if (!response.ok) {
    const error = new Error(
      data?.error || `Request failed (HTTP ${response.status}).`,
    );
    error.status = response.status;
    throw error;
  }
  if (data === null)
    throw new Error(
      `Server returned an empty response (HTTP ${response.status}).`,
    );
  return data;
}
