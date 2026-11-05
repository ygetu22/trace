import path from "node:path";
import { createLocalServer } from "./local-server.ts";

const port = Number(process.env.PORT ?? 3120);
const trace = await createLocalServer({
  port,
  directory: path.resolve("."),
  unlimited:
    process.env.NODE_ENV === "development" &&
    process.env.TRACE_LOCAL_UNLIMITED === "1",
});
trace.server.listen(port, "127.0.0.1", () =>
  console.log(`Trace: http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    trace.abort();
    trace.server.close();
    trace.server.closeIdleConnections();
  });
}
