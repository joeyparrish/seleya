import { loadConfig } from "./config/load.js";
import { openDatabase } from "./db/database.js";
import { createGitHubClient, createDefaultRequest } from "./github/client.js";
import { RefreshController } from "./refresh/orchestrator.js";
import { createApp } from "./api/routes.js";

const { config, token } = loadConfig();
const db = openDatabase(process.env.SELEYA_DB ?? "seleya.db");
const client = createGitHubClient(createDefaultRequest(token));
const refresh = new RefreshController(db, client, config);

// SELEYA_CLIENT_DIR points at the built Plan 3 client; unset means API-only.
const app = createApp({ db, config, refresh, clientDir: process.env.SELEYA_CLIENT_DIR });

app.listen(config.port, config.bindAddress, () => {
  console.log(`Seleya listening on http://${config.bindAddress}:${config.port}`);
  console.log(
    "WARNING: Seleya has no authentication. Do not expose it to untrusted networks; " +
      "gate private-repo access at the network layer.",
  );
});
