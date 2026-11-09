/** App-wired task client: finds the local service the same way the rest of EXILE does. */
import { LOCAL_API, detectLocalApi } from "@/lib/ai";
import { createTaskClient } from "@/lib/taskApi";

let needsRedetect = false;

export const taskClient = createTaskClient({
  getBase: async () => {
    if (LOCAL_API && !needsRedetect) return LOCAL_API;
    const found = await detectLocalApi(needsRedetect);
    needsRedetect = false;
    return found;
  },
  // After a network failure, probe the usual ports again on the next call
  // (the service may have restarted on a different port).
  onDisconnected: () => {
    needsRedetect = true;
  },
});
