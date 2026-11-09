/**
 * Goals and milestones for Mission Control.
 *
 * Stored locally in the browser profile, like EXILE's memory and contacts. The
 * task service has no goal concept, so this does not invent one there: a
 * milestone can optionally be linked to a real task, and it counts as done when
 * the user ticks it OR its linked task has completed. The backend only marks a
 * task completed after its required verification passes, so a linked task is
 * genuine evidence, not a claim.
 *
 * All functions are pure (they return new arrays) except the small store at the
 * bottom, which takes the storage it should use so tests can run without a browser.
 */

import type { TaskStatus } from "../types/tasks";

export interface Milestone {
  id: string;
  title: string;
  done: boolean;
  doneAt: number | null;
  taskId: string | null;
}

export type GoalStatus = "active" | "archived";

export interface Goal {
  id: string;
  title: string;
  description: string;
  /** YYYY-MM-DD, or null for no deadline. */
  targetDate: string | null;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  milestones: Milestone[];
}

export const GOAL_LIMITS = { goals: 50, milestones: 30, title: 120, description: 1000 } as const;

export type MilestoneState = "done" | "done-by-task" | "in-progress" | "blocked" | "task-unknown" | "todo";

const ACTIVE_TASK = new Set<TaskStatus>(["queued", "planning", "running", "waiting_approval", "paused"]);

export type TaskStatusLookup = Record<string, TaskStatus | undefined> | null;

/**
 * `statuses` is null when the task list could not be loaded (service offline):
 * linked milestones then show as "task-unknown" rather than guessing.
 */
export function milestoneState(m: Milestone, statuses: TaskStatusLookup): MilestoneState {
  if (m.done) return "done";
  if (!m.taskId) return "todo";
  if (statuses === null) return "task-unknown";
  const s = statuses[m.taskId];
  if (!s) return "task-unknown";
  if (s === "completed") return "done-by-task";
  if (s === "failed" || s === "cancelled") return "blocked";
  return ACTIVE_TASK.has(s) ? "in-progress" : "todo";
}

export interface GoalProgress {
  done: number;
  total: number;
  percent: number;
  achieved: boolean;
  overdue: boolean;
  /** Whole days until the target date (negative when overdue), or null with no deadline. */
  daysLeft: number | null;
}

function parseDay(day: string | null): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const check = new Date(t);
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? t : null;
}

export function isValidDay(day: string | null): boolean {
  return day === null || parseDay(day) !== null;
}

export function goalProgress(goal: Goal, statuses: TaskStatusLookup, now: number = Date.now()): GoalProgress {
  const total = goal.milestones.length;
  const done = goal.milestones.filter((m) => {
    const s = milestoneState(m, statuses);
    return s === "done" || s === "done-by-task";
  }).length;
  const achieved = total > 0 && done === total;

  const target = parseDay(goal.targetDate);
  let daysLeft: number | null = null;
  if (target !== null) {
    const n = new Date(now);
    const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
    daysLeft = Math.round((target - today) / 86_400_000);
  }
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    achieved,
    overdue: !achieved && daysLeft !== null && daysLeft < 0,
    daysLeft,
  };
}

/* ------------------------------ pure updates ------------------------------ */

const stripControls = (s: string) => Array.from(s, (ch) => { const c = ch.charCodeAt(0); return c < 0x20 || c === 0x7f ? " " : ch; }).join("");
const clean = (s: unknown, max: number) => stripControls(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, max);

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function addGoal(goals: Goal[], input: { title: string; description?: string; targetDate?: string | null }, now = Date.now(), id = crypto.randomUUID()): Result<Goal[]> {
  const title = clean(input.title, GOAL_LIMITS.title);
  if (!title) return { ok: false, error: "A goal needs a title." };
  if (goals.length >= GOAL_LIMITS.goals) return { ok: false, error: `You can keep at most ${GOAL_LIMITS.goals} goals. Archive or delete one first.` };
  const targetDate = input.targetDate || null;
  if (!isValidDay(targetDate)) return { ok: false, error: "The target date is not a valid date." };
  const goal: Goal = { id, title, description: clean(input.description, GOAL_LIMITS.description), targetDate, status: "active", createdAt: now, updatedAt: now, milestones: [] };
  return { ok: true, value: [goal, ...goals] };
}

function mapGoal(goals: Goal[], goalId: string, fn: (g: Goal) => Goal | string, now: number): Result<Goal[]> {
  const index = goals.findIndex((g) => g.id === goalId);
  if (index < 0) return { ok: false, error: "That goal no longer exists." };
  const next = fn(goals[index]);
  if (typeof next === "string") return { ok: false, error: next };
  const copy = [...goals];
  copy[index] = { ...next, updatedAt: now };
  return { ok: true, value: copy };
}

export function updateGoal(goals: Goal[], goalId: string, patch: { title?: string; description?: string; targetDate?: string | null; status?: GoalStatus }, now = Date.now()): Result<Goal[]> {
  return mapGoal(goals, goalId, (g) => {
    const next = { ...g };
    if (patch.title !== undefined) {
      const title = clean(patch.title, GOAL_LIMITS.title);
      if (!title) return "A goal needs a title.";
      next.title = title;
    }
    if (patch.description !== undefined) next.description = clean(patch.description, GOAL_LIMITS.description);
    if (patch.targetDate !== undefined) {
      if (!isValidDay(patch.targetDate)) return "The target date is not a valid date.";
      next.targetDate = patch.targetDate || null;
    }
    if (patch.status !== undefined) next.status = patch.status === "archived" ? "archived" : "active";
    return next;
  }, now);
}

export function deleteGoal(goals: Goal[], goalId: string): Goal[] {
  return goals.filter((g) => g.id !== goalId);
}

export function addMilestone(goals: Goal[], goalId: string, title: string, now = Date.now(), id = crypto.randomUUID()): Result<Goal[]> {
  const text = clean(title, GOAL_LIMITS.title);
  if (!text) return { ok: false, error: "A milestone needs a title." };
  return mapGoal(goals, goalId, (g) => {
    if (g.milestones.length >= GOAL_LIMITS.milestones) return `A goal can have at most ${GOAL_LIMITS.milestones} milestones.`;
    return { ...g, milestones: [...g.milestones, { id, title: text, done: false, doneAt: null, taskId: null }] };
  }, now);
}

function mapMilestone(goals: Goal[], goalId: string, milestoneId: string, fn: (m: Milestone) => Milestone, now: number): Result<Goal[]> {
  return mapGoal(goals, goalId, (g) => {
    if (!g.milestones.some((m) => m.id === milestoneId)) return "That milestone no longer exists.";
    return { ...g, milestones: g.milestones.map((m) => (m.id === milestoneId ? fn(m) : m)) };
  }, now);
}

export function setMilestoneDone(goals: Goal[], goalId: string, milestoneId: string, done: boolean, now = Date.now()): Result<Goal[]> {
  return mapMilestone(goals, goalId, milestoneId, (m) => ({ ...m, done, doneAt: done ? now : null }), now);
}

export function renameMilestone(goals: Goal[], goalId: string, milestoneId: string, title: string, now = Date.now()): Result<Goal[]> {
  const text = clean(title, GOAL_LIMITS.title);
  if (!text) return { ok: false, error: "A milestone needs a title." };
  return mapMilestone(goals, goalId, milestoneId, (m) => ({ ...m, title: text }), now);
}

export function linkMilestoneTask(goals: Goal[], goalId: string, milestoneId: string, taskId: string | null, now = Date.now()): Result<Goal[]> {
  return mapMilestone(goals, goalId, milestoneId, (m) => ({ ...m, taskId }), now);
}

export function removeMilestone(goals: Goal[], goalId: string, milestoneId: string, now = Date.now()): Result<Goal[]> {
  return mapGoal(goals, goalId, (g) => ({ ...g, milestones: g.milestones.filter((m) => m.id !== milestoneId) }), now);
}

/* --------------------------------- storage --------------------------------- */

export const GOALS_KEY = "exile.goals.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Validate whatever was in storage; anything malformed is dropped rather than trusted. */
export function sanitizeGoals(raw: unknown): Goal[] {
  if (!Array.isArray(raw)) return [];
  const goals: Goal[] = [];
  for (const g of raw.slice(0, GOAL_LIMITS.goals)) {
    if (!g || typeof g !== "object") continue;
    const o = g as Record<string, unknown>;
    const title = clean(o.title, GOAL_LIMITS.title);
    if (typeof o.id !== "string" || !o.id || !title) continue;
    const milestones: Milestone[] = [];
    for (const m of (Array.isArray(o.milestones) ? o.milestones : []).slice(0, GOAL_LIMITS.milestones)) {
      if (!m || typeof m !== "object") continue;
      const mo = m as Record<string, unknown>;
      const mt = clean(mo.title, GOAL_LIMITS.title);
      if (typeof mo.id !== "string" || !mo.id || !mt) continue;
      const done = mo.done === true;
      milestones.push({
        id: mo.id,
        title: mt,
        done,
        doneAt: done && Number.isFinite(mo.doneAt) ? (mo.doneAt as number) : null,
        taskId: typeof mo.taskId === "string" && mo.taskId ? mo.taskId.slice(0, 64) : null,
      });
    }
    const targetDate = typeof o.targetDate === "string" && isValidDay(o.targetDate) ? o.targetDate : null;
    goals.push({
      id: o.id,
      title,
      description: clean(o.description, GOAL_LIMITS.description),
      targetDate,
      status: o.status === "archived" ? "archived" : "active",
      createdAt: Number.isFinite(o.createdAt) ? (o.createdAt as number) : Date.now(),
      updatedAt: Number.isFinite(o.updatedAt) ? (o.updatedAt as number) : Date.now(),
      milestones,
    });
  }
  return goals;
}

export function createGoalsStore(storage: StorageLike | null, notify: () => void = () => {}) {
  return {
    load(): Goal[] {
      try {
        const raw = storage?.getItem(GOALS_KEY);
        return raw ? sanitizeGoals(JSON.parse(raw)) : [];
      } catch {
        return [];
      }
    },
    /** Returns false when the data could not be saved (storage blocked or full). */
    save(goals: Goal[]): boolean {
      try {
        if (!storage) return false;
        storage.setItem(GOALS_KEY, JSON.stringify(goals));
        notify();
        return true;
      } catch {
        return false;
      }
    },
  };
}
