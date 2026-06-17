import { pathToFileURL } from "node:url";
import net from "node:net";

export const DEFAULT_PANEL_PORT_START = 3000;
export const DEFAULT_PANEL_PORT_END = 3099;
export const DEFAULT_PANEL_HOST = "0.0.0.0";

function readIntegerEnv(env, name, fallback) {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isInteger(value) ? value : fallback;
}

export function resolvePanelPortRange(env = process.env) {
  const start = readIntegerEnv(env, "PANEL_PORT_START", DEFAULT_PANEL_PORT_START);
  const end = readIntegerEnv(env, "PANEL_PORT_END", DEFAULT_PANEL_PORT_END);
  if (start < 1 || end < start || end > 65535) {
    throw new Error(`Invalid panel port range: ${start}-${end}`);
  }
  return { start, end };
}

export function canListen(port, host = DEFAULT_PANEL_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function selectPanelPort(options = {}) {
  const env = options.env ?? process.env;
  const host = options.host ?? env.PANEL_HOST ?? DEFAULT_PANEL_HOST;
  const { start, end } = options.range ?? resolvePanelPortRange(env);

  for (let port = start; port <= end; port += 1) {
    if (await canListen(port, host)) {
      return port;
    }
  }
  return null;
}

async function main() {
  const { start, end } = resolvePanelPortRange();
  const port = await selectPanelPort({ range: { start, end } });
  if (port === null) {
    console.error(`No available panel port in range ${start}-${end}.`);
    process.exitCode = 1;
    return;
  }
  console.log(port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
