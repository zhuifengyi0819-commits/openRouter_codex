import { exec } from "node:child_process";

import { buildServer } from "../server.js";

function resolveAdminHost(host: string): string {
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      process.stdout.write("Could not open browser automatically. Open the admin URL manually.\n");
    }
  });
}

const { app, config, runtime, setupTokens } = await buildServer();

try {
  await app.listen({ host: config.host, port: config.port });

  const setupToken = setupTokens.create();
  const adminHost = resolveAdminHost(config.host);
  const adminUrl = `http://${adminHost}:${config.port}/admin/setup?setupToken=${setupToken}`;

  process.stdout.write("Gateway admin is ready.\n");
  process.stdout.write(`Open this link in your browser:\n${adminUrl}\n\n`);
  process.stdout.write("Use the \"Connect Codex Team\" button in the web page to add or refresh Teams.\n");
  process.stdout.write(`Gateway base URL: http://localhost:${config.port}/v1\n`);
  process.stdout.write(`Configured upstreams: ${runtime.getConfig().upstreams.length}\n`);

  openBrowser(adminUrl);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
