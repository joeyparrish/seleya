import { existsSync } from "node:fs";
import { loadConfig } from "./config/load.js";
import { openDatabase } from "./db/database.js";
import { createGitHubClient, createDefaultRequest } from "./github/client.js";
import { RefreshController } from "./refresh/orchestrator.js";
import { createApp } from "./api/routes.js";

const { config, token } = loadConfig();
const db = openDatabase(process.env.SELEYA_DB ?? "seleya.db");
const client = createGitHubClient(createDefaultRequest(token));
const refresh = new RefreshController(db, client, config);

// Serve the built client when present; SELEYA_CLIENT_DIR overrides. Unset and
// absent means API-only (e.g. when running the Vite dev server separately).
const clientDir =
  process.env.SELEYA_CLIENT_DIR ?? (existsSync("dist/client") ? "dist/client" : undefined);
const app = createApp({ db, config, refresh, clientDir });

app.listen(config.port, config.bindAddress, () => {
  console.log(`Seleya listening on http://${config.bindAddress}:${config.port}`);
  console.log(clientDir ? `Serving UI from ${clientDir}` : "API only (no client build found)");
  console.log(
    "WARNING: Seleya has no authentication. Do not expose it to untrusted networks; " +
      "gate private-repo access at the network layer.",
  );
});
