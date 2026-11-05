import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkWebsite } from "./basic-check.ts";
import { DailyQuota, type Usage } from "./daily-quota.ts";
import { parseTarget, resolvePublicHost } from "./network-policy.ts";
import { TraceError } from "./errors.ts";
import { parseFeatureCheck } from "./explore.ts";

export async function createLocalServer(options: {
  port: number;
  directory: string;
  investigate?: typeof checkWebsite;
  unlimited?: boolean;
  unlimitedUntil?: string;
}) {
  const quota = await DailyQuota.open(
    path.join(options.directory, "data/usage"),
  );
  const investigate = options.investigate ?? checkWebsite;
  let savedDeadline = "";
  try {
    savedDeadline = await readFile(
      path.join(options.directory, "data/usage/local-unlimited-until"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const deadline =
    options.unlimitedUntil ??
    process.env.TRACE_LOCAL_UNLIMITED_UNTIL ??
    savedDeadline.trim();
  const unlimitedUntil = /(?:Z|[+-]\d{2}:\d{2})$/i.test(deadline)
    ? Date.parse(deadline)
    : Number.NaN;
  const unlimitedUsage: Usage = {
    remaining: 3,
    retryAt: null,
    unlimited: true,
  };
  const isUnlimited = () =>
    options.unlimited === true ||
    (Number.isFinite(unlimitedUntil) && Date.now() < unlimitedUntil);
  const getUsage = (address: string) =>
    isUnlimited() ? Promise.resolve(unlimitedUsage) : quota.peek(address);
  const staticFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ]);
  let active: AbortController | undefined;
  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const bound = server.address();
    const port = bound && typeof bound === "object" ? bound.port : options.port;
    const host = request.headers.host;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? "")) {
      json(403, { error: "Trace is local to this machine." });
      return;
    }
    // Only the socket identifies a client; untrusted forwarded headers are ignored.
    const address = request.socket.remoteAddress;
    if (!address) {
      json(503, { error: "The client address could not be identified." });
      return;
    }
    try {
      const pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
      if (request.method === "GET" && pathname === "/api/usage") {
        json(200, await getUsage(address));
        return;
      }
      if (request.method === "GET" && staticFiles.has(pathname)) {
        const [filename, contentType] = staticFiles.get(pathname)!;
        const contents = await readFile(
          path.join(options.directory, "web", filename!),
        );
        response.writeHead(200, { "Content-Type": contentType! });
        response.end(contents);
        return;
      }
      if (request.method !== "POST" || pathname !== "/api/captures") {
        json(404, { error: "This address was not found." });
        return;
      }
      if (request.headers.origin && request.headers.origin !== `http://${host}`)
        throw new TraceError("Start checks from Trace's local page.", 403);
      if (request.headers["content-type"]?.split(";")[0] !== "application/json")
        throw new TraceError("Use application/json.", 415);
      if (active)
        throw new TraceError(
          "Another check is running. Please try when it finishes.",
          429,
        );
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 90_000);
      const cancel = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.once("close", cancel);
      try {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096)
            throw new TraceError("The request is too large.", 413);
        }
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          throw new TraceError("Send a JSON object containing a URL.", 400);
        }
        const featureCheck = parseFeatureCheck(input?.featureCheck);
        const target = parseTarget(input?.url);
        await resolvePublicHost(target.hostname);
        controller.signal.throwIfAborted();
        const usage = isUnlimited()
          ? unlimitedUsage
          : await quota.consume(address);
        const report = await investigate(
          target.href,
          controller.signal,
          featureCheck,
        );
        if (!response.destroyed) json(201, { ...report, usage });
      } finally {
        clearTimeout(timeout);
        response.removeListener("close", cancel);
        active = undefined;
      }
    } catch (error) {
      if (response.destroyed) return;
      const usage = await getUsage(address).catch(() => undefined);
      const status = error instanceof TraceError ? error.status : 503;
      if (status === 429 && usage?.retryAt)
        response.setHeader(
          "Retry-After",
          String(
            Math.max(
              1,
              Math.ceil((Date.parse(usage.retryAt) - Date.now()) / 1000),
            ),
          ),
        );
      json(status, {
        error:
          error instanceof TraceError
            ? error.message
            : "Trace could not safely complete this request. Please try later.",
        usage,
      });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 32;
  return { server, abort: () => active?.abort() };
}
