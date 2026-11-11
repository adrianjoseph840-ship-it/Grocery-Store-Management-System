// Tests the browser's user-facing messages for broken and non-JSON API responses.
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "../web/api.js";

test("API client explains empty and invalid server responses", async () => {
  await assert.rejects(
    request("/example", {}, async () => new Response("", { status: 200 })),
    /empty response \(HTTP 200\)/,
  );
  await assert.rejects(
    request(
      "/example",
      {},
      async () => new Response("<html>proxy error</html>", { status: 502 }),
    ),
    /invalid response \(HTTP 502\)/,
  );
});

test("API client reports connection and JSON errors clearly", async () => {
  await assert.rejects(
    request("/example", {}, async () => {
      throw new Error("socket closed");
    }),
    /Cannot connect to the canteen server/,
  );
  await assert.rejects(
    request(
      "/example",
      {},
      async () =>
        new Response('{"error":"Invalid credentials"}', { status: 401 }),
    ),
    /Invalid credentials/,
  );
});

test("API client identifies a static preview server at login", async () => {
  await assert.rejects(
    request(
      "/login",
      { method: "POST", body: "{}" },
      async () => new Response("", { status: 405 }),
    ),
    /static preview server.*node src\/server\.js/,
  );
  await assert.rejects(
    request(
      "/health",
      {},
      async () => new Response("Not found", { status: 404 }),
    ),
    /static preview server/,
  );
});
