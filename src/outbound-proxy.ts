import http from "node:http";
import net from "node:net";
import type { Socket } from "node:net";
import { parseTarget, resolvePublicHost } from "./network-policy.ts";

/** Resolve and pin each connection so redirects and subresources cannot reach private hosts. */
export async function startOutboundProxy(options: { host?: string; port?: number } = {}) {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    if (sockets.size >= 128) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(15_000, () => socket.destroy());
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = parseTarget(request.url);
      if (url.protocol !== "http:" || !["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(403, { "X-Trace-Policy-Blocked": "1" }).end();
        return;
      }
      const address = await resolvePublicHost(url.hostname);
      if (response.destroyed) return;

      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const upstream = http.request({
        hostname: address,
        port: 80,
        path: url.pathname + url.search,
        method: request.method,
        headers,
        agent: false,
      }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on("socket", track);
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502, { "X-Trace-Proxy-Error": "1" });
        response.end();
      });
      response.on("close", () => upstream.destroy());
      upstream.end();
    } catch {
      response.writeHead(403, { "X-Trace-Policy-Blocked": "1" }).end();
    }
  });

  server.on("connection", track);
  server.maxConnections = 64;
  server.requestTimeout = 20_000;
  server.headersTimeout = 5_000;
  server.on("connect", async (request, client, head) => {
    try {
      const destination = new URL(`https://${request.url}`);
      if (destination.port || destination.pathname !== "/" || destination.username || destination.password) {
        throw new Error("Unsupported tunnel destination");
      }
      const address = await resolvePublicHost(destination.hostname);
      if (client.destroyed) return;

      const upstream = net.connect({ host: address, port: 443 });
      track(upstream);
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch {
      if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind a port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
