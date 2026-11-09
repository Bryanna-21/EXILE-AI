/**
 * Real system checks for the Systems Monitor. Every row is derived from something that was
 * actually probed; nothing is simulated. Pure so it can be tested without a browser.
 */

import type { TaskCapabilities } from "../types/tasks";

export type CheckState = "ok" | "warn" | "down" | "n/a";

export interface CheckRow {
  id: string;
  name: string;
  state: CheckState;
  detail: string;
}

export interface CheckInputs {
  browserOnline: boolean;
  /** Result of GET /health on the local API; null when the local API could not be reached. */
  health: { providers: string[]; keysDetected: number } | null;
  /** Result of GET /tasks/capabilities; null when unavailable. */
  tasks: TaskCapabilities | null;
  desktopBridge: boolean;
  nativeAppCount: number | null;
}

export function evaluateSystems(i: CheckInputs): CheckRow[] {
  const rows: CheckRow[] = [];

  rows.push({
    id: "network",
    name: "Network",
    state: i.browserOnline ? "ok" : "down",
    detail: i.browserOnline ? "The browser reports it is online." : "The browser reports it is offline.",
  });

  rows.push(
    i.health
      ? { id: "api", name: "Local EXILE API", state: "ok", detail: "Reachable on this computer." }
      : { id: "api", name: "Local EXILE API", state: "down", detail: "Not reachable. Start the EXILE local server to use tasks, WhatsApp and local AI." },
  );

  if (!i.health) {
    rows.push({ id: "ai", name: "AI providers", state: "n/a", detail: "Unknown while the local API is unreachable." });
  } else if (i.health.providers.length > 0) {
    rows.push({ id: "ai", name: "AI providers", state: "ok", detail: `${i.health.providers.length} ready: ${i.health.providers.join(", ")}.` });
  } else {
    rows.push({ id: "ai", name: "AI providers", state: "warn", detail: "No provider key found. Chat and analysis fall back to limited offline behaviour." });
  }

  if (!i.tasks) {
    rows.push({ id: "tasks", name: "Task engine", state: i.health ? "warn" : "n/a", detail: i.health ? "Could not read the task engine status." : "Unknown while the local API is unreachable." });
  } else {
    const available = i.tasks.tools.filter((t) => t.available).length;
    rows.push({
      id: "tasks",
      name: "Task engine",
      state: i.tasks.planner.configured ? "ok" : "warn",
      detail: i.tasks.planner.configured
        ? `Planner ready; ${available} of ${i.tasks.tools.length} tools available.`
        : `No planning provider; new tasks fail at planning. ${available} of ${i.tasks.tools.length} tools available.`,
    });
  }

  rows.push({
    id: "desktop",
    name: "Desktop bridge",
    state: i.desktopBridge ? "ok" : "n/a",
    detail: i.desktopBridge
      ? i.nativeAppCount === null ? "Connected to the EXILE desktop app." : `Connected; ${i.nativeAppCount} program${i.nativeAppCount === 1 ? "" : "s"} imported.`
      : "Not running inside the EXILE desktop app, so local programs cannot be launched.",
  });

  return rows;
}

export function overallState(rows: CheckRow[]): { label: string; state: CheckState } {
  if (rows.some((r) => r.state === "down")) return { label: "ATTENTION NEEDED", state: "down" };
  if (rows.some((r) => r.state === "warn")) return { label: "PARTLY READY", state: "warn" };
  return { label: "ALL CHECKS PASSED", state: "ok" };
}
