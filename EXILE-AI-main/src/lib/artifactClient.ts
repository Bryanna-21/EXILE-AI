/** App-wired artifact client: finds the local service the same way the rest of EXILE does. */
import { LOCAL_API, detectLocalApi } from "@/lib/ai";
import { createArtifactClient } from "@/lib/artifactApi";

let needsRedetect = false;

function authSecret(): string {
  try {
    return localStorage.getItem("exile_local_auth") || "";
  } catch {
    return "";
  }
}

export const artifactClient = createArtifactClient({
  getBase: async () => {
    if (LOCAL_API && !needsRedetect) return LOCAL_API;
    const found = await detectLocalApi(needsRedetect);
    needsRedetect = false;
    return found;
  },
  getAuthSecret: authSecret,
  onDisconnected: () => {
    needsRedetect = true;
  },
});
