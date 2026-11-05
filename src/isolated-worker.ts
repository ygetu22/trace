import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { capturePage } from "./capture.ts";
import { parseFeatureCheck } from "./explore.ts";

// This entry point only runs inside a disposable, secret-free container.
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 4096) throw new Error("Input too large");
}
const request = JSON.parse(input);
const report = await capturePage(request.url, "/tmp/runs", AbortSignal.timeout(90_000), parseFeatureCheck(request.featureCheck), {
  proxyUrl: "http://172.30.0.2:8080",
});
const artifacts: Record<string, string> = {};
let bytes = 0;
for (const file of await readdir(path.join("/tmp/runs", report.id))) {
  const contents = await readFile(path.join("/tmp/runs", report.id, file));
  bytes += contents.length;
  if (bytes > 24 * 1024 * 1024) throw new Error("Evidence exceeds the public demo limit");
  artifacts[file] = contents.toString("base64");
}
process.stdout.write(JSON.stringify({ report, artifacts }));
