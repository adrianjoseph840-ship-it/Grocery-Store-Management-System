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

  // A preview server can serve HTML/CSS but cannot process our /api routes.
  if (
    (path === "/health" && [404, 405].includes(response.status)) ||
    (path === "/login" && response.status === 405)
  ) {
    const error = new Error(
      "This page is on a static preview server. Run 'node src/server.js' in the project folder, then open http://127.0.0.1:3000/ instead.",
    );
    error.status = response.status;
    throw error;
  }

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    if (path === "/health")
      throw new Error(
        "This page is not connected to the Canteen API. Run 'node src/server.js' and open http://127.0.0.1:3000/.",
      );
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
