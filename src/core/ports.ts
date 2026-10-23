// A private dev-server port per ticket: base + ticket number; if something already listens there, +1000, +2000…
import { createConnection, createServer } from "node:net";

export function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const c = createConnection({ host: "127.0.0.1", port });
    c.once("connect", () => (c.destroy(), done(true)));
    c.once("error", () => {
      const s = createServer();
      s.once("error", () => done(true));
      s.listen(port, "127.0.0.1", () => s.close(() => done(false)));
    });
    c.setTimeout(500, () => (c.destroy(), done(false)));
  });
}

export async function pickPort(base: number, n: number): Promise<number> {
  for (let k = 0; k < 8; k++) {
    const port = base + n + 1000 * k;
    if (port < 65536 && !(await portBusy(port))) return port;
    console.log(`  port ${port} is in use — trying ${port + 1000}`);
  }
  return base + n;
}
