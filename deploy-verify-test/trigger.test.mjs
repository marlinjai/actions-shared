// Runs the real "Trigger Coolify deploy webhook" step script from the workflow
// against a local fake of Coolify's deploy endpoint. No network, no secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const wf = join(dirname(fileURLToPath(import.meta.url)), "..", ".github/workflows/coolify-deploy-verify.yml");

function stepScript(name) {
  const lines = readFileSync(wf, "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes(`name: ${name}`));
  assert.ok(start >= 0, `step ${name} not found`);
  const run = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = run + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && lines[i].match(/^\s*/)[0].length < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join("\n");
}

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// Fake Coolify: bearer required, GET answers 405 exactly as Coolify 4.7.5 does.
function coolify(postReply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.method);
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { message: "Unauthenticated." });
    if (req.method !== "POST") return send(405, { message: "This endpoint has changed to a POST request." });
    return send(...postReply);
  });
  return { server, seen };
}

async function runStep(server, { token = "test-token", transform = (s) => s } = {}) {
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), "dv-"));
  const out = join(dir, "output");
  writeFileSync(out, "");
  const script = join(dir, "step.sh");
  writeFileSync(script, transform(stepScript("Trigger Coolify deploy webhook")));
  const child = spawn("bash", [script], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, COOLIFY_TOKEN: token,
      COOLIFY_WEBHOOK: `http://127.0.0.1:${port}/api/v1/deploy?uuid=app-uuid` },
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  const status = await new Promise((r) => child.on("close", r));
  server.close();
  return { status, stdout, outputs: readFileSync(out, "utf8") };
}

test("sends POST and tracks the deployment uuid on success", async () => {
  const { server, seen } = coolify([200, { deployments: [{ deployment_uuid: "dep-123" }] }]);
  const r = await runStep(server);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(seen, ["POST"]);
  assert.match(r.outputs, /deployment_uuid=dep-123/);
  assert.match(r.outputs, /base_url=http:\/\/127\.0\.0\.1:\d+/);
});

test("2xx without a deployment_uuid warns and skips the status gate", async () => {
  const r = await runStep(coolify([200, { message: "queued" }]).server);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /::warning::Could not parse deployment_uuid/);
  assert.match(r.outputs, /deployment_uuid=\n/);
});

test("a rejected token (401) fails the step and surfaces Coolify's message", async () => {
  const r = await runStep(coolify([200, {}]).server, { token: "wrong" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::.*HTTP 401: Unauthenticated\./);
});

test("a 405 from the endpoint fails with the reason and never reaches the status gate", async () => {
  const r = await runStep(coolify([405, { message: "This endpoint has changed to a POST request." }]).server);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::.*HTTP 405: This endpoint has changed to a POST request\./);
  assert.doesNotMatch(r.outputs, /deployment_uuid/);
});

test("a 500 with a non-JSON body still fails cleanly", async () => {
  const server = http.createServer((q, p) => { p.writeHead(500); p.end("<html>boom</html>"); });
  const r = await runStep(server);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::.*HTTP 500/);
});

test("regression: without -X POST (the old GET) the fake answers 405, so the flag is what fixes it", async () => {
  const { server } = coolify([200, { deployments: [{ deployment_uuid: "d" }] }]);
  const r = await runStep(server, { transform: (s) => s.replace("-X POST ", "") });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /HTTP 405/);
});
