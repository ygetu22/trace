import { startOutboundProxy } from "./outbound-proxy.ts";

// Listen only on the isolated Docker network, never the public-facing interface.
const proxy = await startOutboundProxy({ host: "172.30.0.2", port: 8080 });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void proxy.close(); });
}
