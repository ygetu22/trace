import { createGateway } from "./gateway-server.ts";
import { checkIsolation } from "./isolation-check.ts";

const secret = process.env.TRACE_SERVICE_KEY;
if (!secret || secret.length < 32) throw new Error("Set a server-only TRACE_SERVICE_KEY of at least 32 characters");
// Refuse to listen until the real network and Chromium sandbox checks succeed.
await checkIsolation();
const gateway = createGateway(secret);
gateway.server.listen(3121, "127.0.0.1", () => console.log("Trace gateway: http://127.0.0.1:3121"));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    gateway.abort();
    gateway.server.close();
    gateway.server.closeIdleConnections();
  });
}
