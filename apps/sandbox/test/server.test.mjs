import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";

import { createSandboxServer, runtimeCsp } from "../server.mjs";

let server;
let port;

before(async () => {
  server = createSandboxServer({ frameAncestors: ["http://127.0.0.1:3000"] });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(() => server.close());

function get(path, method = "GET") {
  return new Promise((resolve, reject) => {
    // Raw path: no client-side normalisation, so traversal attempts reach the server as written.
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("runtime page has a CSP that blocks all network access and unknown embedders", async () => {
  const res = await get("/runtime.html");
  assert.equal(res.status, 200);
  const csp = res.headers["content-security-policy"];
  assert.equal(csp, runtimeCsp(["http://127.0.0.1:3000"]));
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "worker-src 'none'",
    "frame-ancestors http://127.0.0.1:3000",
  ]) {
    assert.ok(csp.includes(directive), directive);
  }
  // No remote origins anywhere in the policy except the allowed embedder.
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1:3000)/.test(csp));
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.body, /<script src="\/runtime\.js"><\/script>/);
});

test("serves vendored libraries with a deny-all CSP", async () => {
  const res = await get("/vendor/react.min.js");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /^text\/javascript/);
  assert.equal(res.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
});

test("refuses traversal, unknown types and directories", async () => {
  for (const path of [
    "/../server.mjs",
    "/%2e%2e/server.mjs",
    "/..%2fserver.mjs",
    "/..%5cserver.mjs",
    "/vendor/../../package.json",
    "/vendor",
    "/vendor/",
    "/nope.html",
    "/runtime.html%00.js",
  ]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
  }
});

test("only GET and HEAD", async () => {
  assert.equal((await get("/runtime.html", "POST")).status, 405);
  assert.equal((await get("/runtime.html", "PUT")).status, 405);
  assert.equal((await get("/runtime.html", "HEAD")).status, 200);
});
