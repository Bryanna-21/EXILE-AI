import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { taskClient } from "@/lib/taskClient";
import { isFailure, type ApiFailure } from "@/lib/taskApi";
import { ACTION_LABELS, isLive, nextPollDelay } from "@/lib/missionControl";
import type { TaskAction, TaskCapabilities, TaskRecord, TaskSummary } from "@/types/tasks";

export type LoadState = "loading" | "ready" | "disconnected" | "error";

export interface Connection {
  /** True when the most recent list request succeeded. */
  ok: boolean;
  failure: ApiFailure | null;
  /** When data was last fetched successfully (ms), or null if never. */
  lastOkAt: number | null;
}

/**
 * Live view of the local task service for Mission Control.
 *
 * - Polls the lightweight list, and the open task's full record while it is live.
 * - Keeps showing the last known data when the service goes away, marked stale.
 * - Slows down when the window is hidden or the service is unreachable.
 * - Ignores out-of-order responses so an old reply never overwrites a newer one.
 */
export function useMissionTasks() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [load, setLoad] = useState<LoadState>("loading");
  const [connection, setConnection] = useState<Connection>({ ok: false, failure: null, lastOkAt: null });
  const [capabilities, setCapabilities] = useState<TaskCapabilities | null>(null);
  const [capabilitiesFailure, setCapabilitiesFailure] = useState<ApiFailure | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [detailFailure, setDetailFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});

  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const mounted = useRef(true);
  const selectedRef = useRef<string | null>(null);
  const tasksRef = useRef<TaskSummary[]>([]);
  const connectedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  selectedRef.current = selectedId;

  const refreshCapabilities = useCallback(async () => {
    const r = await taskClient.getCapabilities();
    if (!mounted.current) return;
    if (r.ok) {
      setCapabilities(r.data);
      setCapabilitiesFailure(null);
    } else if (isFailure(r)) {
      setCapabilitiesFailure(r);
    }
  }, []);

  const refreshList = useCallback(async () => {
    const seq = ++listSeq.current;
    const r = await taskClient.listTasks();
    if (!mounted.current || seq !== listSeq.current) return;
    if (r.ok) {
      const wasConnected = connectedRef.current;
      connectedRef.current = true;
      tasksRef.current = r.data;
      setTasks(r.data);
      setLoad("ready");
      setConnection({ ok: true, failure: null, lastOkAt: Date.now() });
      if (!wasConnected) void refreshCapabilities();
    } else if (isFailure(r)) {
      connectedRef.current = false;
      setConnection((c) => ({ ok: false, failure: r, lastOkAt: c.lastOkAt }));
      setLoad((prev) => (prev === "ready" ? "ready" : r.kind === "disconnected" ? "disconnected" : "error"));
    }
  }, [refreshCapabilities]);

  const refreshDetail = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    const seq = ++detailSeq.current;
    const r = await taskClient.getTask(id);
    if (!mounted.current || seq !== detailSeq.current || selectedRef.current !== id) return;
    if (r.ok) {
      setDetail(r.data);
      setDetailFailure(null);
    } else if (isFailure(r)) {
      setDetailFailure(r);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshList(), refreshDetail()]);
  }, [refreshList, refreshDetail]);

  // Polling loop with adaptive delay.
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const tick = async () => {
      await refreshAll();
      if (cancelled) return;
      const open = tasksRef.current.find((t) => t.id === selectedRef.current);
      const delay = nextPollDelay({
        hidden: typeof document !== "undefined" && document.hidden,
        connected: connectedRef.current,
        hasLiveTask: tasksRef.current.some((t) => isLive(t.status)) || (!!open && isLive(open.status)),
        detailOpen: !!selectedRef.current,
      });
      timer.current = setTimeout(tick, delay);
    };
    void tick();
    const onVisible = () => {
      if (document.hidden || cancelled) return;
      if (timer.current) clearTimeout(timer.current);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshAll]);

  const select = useCallback(
    (id: string | null) => {
      selectedRef.current = id;
      detailSeq.current++;
      setSelectedId(id);
      setDetail(null);
      setDetailFailure(null);
      if (id) void refreshDetail();
    },
    [refreshDetail],
  );

  const failureToast = (f: ApiFailure) => toast.error(f.message);

  const runAction = useCallback(
    async (id: string, action: TaskAction) => {
      setBusy((b) => ({ ...b, [id]: action }));
      const r = await taskClient.control(id, action);
      if (!mounted.current) return;
      setBusy((b) => {
        const { [id]: _removed, ...rest } = b;
        return rest;
      });
      if (r.ok) toast.success(ACTION_LABELS[action].done);
      else if (isFailure(r)) failureToast(r);
      await refreshAll();
    },
    [refreshAll],
  );

  const decide = useCallback(
    async (taskId: string, requestId: string, approved: boolean) => {
      setBusy((b) => ({ ...b, [taskId]: approved ? "approve" : "refuse" }));
      const r = await taskClient.decideApproval(taskId, requestId, approved);
      if (!mounted.current) return r;
      setBusy((b) => {
        const { [taskId]: _removed, ...rest } = b;
        return rest;
      });
      if (r.ok) toast.success(approved ? "Approved. The task continues." : "Refused. That step will not run.");
      else if (isFailure(r)) failureToast(r);
      await refreshAll();
      return r;
    },
    [refreshAll],
  );

  const create = useCallback(
    async (objective: string, start: boolean) => {
      const r = await taskClient.createTask({ objective, start });
      if (!mounted.current) return r;
      if (r.ok) {
        toast.success(start ? "Task created and started." : "Task created. Start it when you are ready.");
        await refreshList();
        select(r.data.id);
      } else if (isFailure(r)) {
        failureToast(r);
      }
      return r;
    },
    [refreshList, select],
  );

  return {
    tasks, load, connection, capabilities, capabilitiesFailure,
    selectedId, detail, detailFailure, busy,
    select, refreshAll, refreshCapabilities, runAction, decide, create,
  };
}
