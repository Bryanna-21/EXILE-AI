import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Zap, Bell, Activity, Sparkles, Brain, Trash2, RefreshCw, ListChecks } from 'lucide-react';
import { CAPABILITIES, STATUS_LABEL, STATUS_TONE } from '@/lib/capabilities';
import { loadMemory, removeMemory, addMemory, type MemoryEntry } from '@/lib/memory';
import { loadLog, clearLog, type ReasoningEvent, logReasoning } from '@/lib/reasoningLog';
import { countByStatus, formatClock } from '@/lib/missionControl';
import { useMissionTasks } from '@/hooks/useMissionTasks';
import TaskComposer from '@/components/mission/TaskComposer';
import TaskList from '@/components/mission/TaskList';
import TaskDetail from '@/components/mission/TaskDetail';
import GoalsPanel from '@/components/mission/GoalsPanel';
import AgentPanel from '@/components/mission/AgentPanel';
import { Pill, StateBanner } from '@/components/mission/ui';

interface MissionControlProps {
  onOpenSection: (id: string) => void;
}

const MissionControl = ({ onOpenSection }: MissionControlProps) => {
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [log, setLog] = useState<ReasoningEvent[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [tab, setTab] = useState('tasks');
  const m = useMissionTasks();

  useEffect(() => {
    const refresh = () => {
      setMemory(loadMemory());
      setLog(loadLog());
    };
    refresh();
    window.addEventListener('exile:memory-updated', refresh);
    window.addEventListener('exile:reasoning-updated', refresh);
    return () => {
      window.removeEventListener('exile:memory-updated', refresh);
      window.removeEventListener('exile:reasoning-updated', refresh);
    };
  }, []);

  const counts = useMemo(() => countByStatus(m.tasks), [m.tasks]);
  const disconnected = !m.connection.ok && m.load !== 'loading';
  const tasksKnown = m.connection.lastOkAt !== null;
  const liveCaps = CAPABILITIES.filter((c) => c.status === 'live').length;

  const suggestions = useMemo(() => {
    const out: string[] = [];
    if (disconnected) out.push('The task service is unreachable. Start the EXILE desktop app or local server to run tasks.');
    if (counts.waiting > 0) out.push(`${counts.waiting} task${counts.waiting === 1 ? ' is' : 's are'} waiting for your approval.`);
    const interrupted = m.tasks.filter((t) => t.status === 'paused' && t.hasRecovery).length;
    if (interrupted > 0) out.push(`${interrupted} task${interrupted === 1 ? ' was' : 's were'} interrupted by a restart. Review ${interrupted === 1 ? 'it' : 'them'} before resuming.`);
    if (m.capabilities && !m.capabilities.planner.configured) out.push('No reasoning provider key is configured, so new tasks cannot be planned.');
    if (counts.failed > 0) out.push(`${counts.failed} task${counts.failed === 1 ? '' : 's'} failed. Open one to see why.`);
    out.push(memory.length === 0 ? 'Add your first memory in the Overview tab.' : `${memory.length} fact${memory.length === 1 ? '' : 's'} stored in memory.`);
    return out;
  }, [disconnected, counts, m.tasks, m.capabilities, memory.length]);

  const openTask = (id: string) => {
    setTab('tasks');
    m.select(id);
  };

  const failure = m.connection.failure;
  const bannerTitle =
    failure?.kind === 'timeout' ? 'The task service is not answering'
    : failure?.kind === 'forbidden' ? 'The task service refused this app'
    : failure?.kind === 'disconnected' ? 'Disconnected from the task service'
    : 'The task service reported a problem';

  return (
    <div className="p-4 space-y-4">
      {/* Live header stats: all from the real task service and local stores */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Running', value: tasksKnown ? counts.running : '—', icon: Activity },
          { label: 'Need approval', value: tasksKnown ? counts.waiting : '—', icon: Bell },
          { label: 'Completed', value: tasksKnown ? counts.completed : '—', icon: ListChecks },
          { label: 'Failed', value: tasksKnown ? counts.failed : '—', icon: Zap },
        ].map((s) => (
          <Card key={s.label} className="bg-slate-900/60 border-cyan-500/30 p-3 text-center">
            <s.icon className="w-4 h-4 text-cyan-300 mx-auto mb-1" aria-hidden />
            <div className="text-xl font-mono text-cyan-100">{s.value}</div>
            <div className="text-[9px] tracking-widest text-cyan-400/60 uppercase">{s.label}</div>
          </Card>
        ))}
      </div>

      {/* Connection state */}
      {m.load === 'loading' && <div role="status" className="text-xs text-cyan-400/70">Connecting to the task service…</div>}
      {disconnected && (
        <StateBanner
          tone={failure?.kind === 'disconnected' ? 'bad' : 'warn'}
          title={bannerTitle}
          action={
            <Button size="sm" variant="ghost" className="h-7 border border-current text-[10px]" onClick={() => void m.refreshAll()}>
              <RefreshCw className="w-3 h-3 mr-1" /> Retry
            </Button>
          }
        >
          {failure?.message}
          {tasksKnown && <> Showing the last data received at {formatClock(new Date(m.connection.lastOkAt as number).toISOString())}; it may be out of date.</>}
          {' '}It retries automatically.
        </StateBanner>
      )}

      <Card className="bg-slate-900/60 border-cyan-500/30 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Bell className="w-4 h-4 text-cyan-300" aria-hidden />
          <h3 className="text-xs tracking-widest text-cyan-200 uppercase">Needs attention</h3>
        </div>
        <ul className="space-y-1 text-xs text-cyan-100/80">
          {suggestions.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-cyan-400">›</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid grid-cols-4 bg-slate-900/70 border border-cyan-500/30 h-auto">
          <TabsTrigger value="tasks" className="text-[10px] tracking-widest uppercase">Tasks{counts.waiting > 0 ? ` (${counts.waiting})` : ''}</TabsTrigger>
          <TabsTrigger value="goals" className="text-[10px] tracking-widest uppercase">Goals</TabsTrigger>
          <TabsTrigger value="agents" className="text-[10px] tracking-widest uppercase">Agents</TabsTrigger>
          <TabsTrigger value="overview" className="text-[10px] tracking-widest uppercase">Overview</TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="space-y-4 mt-3">
          {m.selectedId ? (
            <TaskDetail
              detail={m.detail}
              failure={m.detailFailure}
              busy={m.busy[m.selectedId]}
              stale={disconnected}
              onAction={(a) => void m.runAction(m.selectedId as string, a)}
              onDecide={(requestId, approved) => void m.decide(m.selectedId as string, requestId, approved)}
              onClose={() => m.select(null)}
            />
          ) : (
            <>
              <TaskComposer
                onCreate={m.create}
                plannerConfigured={m.capabilities ? m.capabilities.planner.configured : null}
                disconnected={disconnected && !tasksKnown}
              />
              {m.load === 'loading' && <div role="status" className="text-xs text-cyan-400/70">Loading tasks…</div>}
              {m.load !== 'loading' && !tasksKnown && disconnected && (
                <p className="text-[11px] text-cyan-400/60 italic">No task data yet. Tasks appear here once the task service is reachable.</p>
              )}
              {tasksKnown && m.tasks.length === 0 && (
                <p className="text-[11px] text-cyan-400/60 italic">No tasks yet. Describe an outcome above to create one.</p>
              )}
              {m.tasks.length > 0 && <TaskList tasks={m.tasks} selectedId={m.selectedId} onSelect={m.select} />}
            </>
          )}
        </TabsContent>

        <TabsContent value="goals" className="mt-3">
          <GoalsPanel
            tasks={m.tasks}
            tasksKnown={tasksKnown && m.connection.ok}
            disconnected={disconnected}
            onCreateTask={m.create}
            onOpenTask={openTask}
          />
        </TabsContent>

        <TabsContent value="agents" className="mt-3">
          <AgentPanel capabilities={m.capabilities} capabilitiesFailure={m.capabilitiesFailure} log={log} tasks={m.tasks} />
        </TabsContent>

        <TabsContent value="overview" className="space-y-4 mt-3">
          {/* Capabilities: statuses are audited against the code, see src/lib/capabilities.ts */}
          <Card className="bg-slate-900/60 border-cyan-500/30 p-3">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-cyan-300" aria-hidden />
                <h3 className="text-xs tracking-widest text-cyan-200 uppercase">Capability audit</h3>
              </div>
              <span className="text-[9px] text-cyan-400/60 tracking-widest">{liveCaps} OF {CAPABILITIES.length} WORKING</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {CAPABILITIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => c.section && onOpenSection(c.section)}
                  className="text-left p-2 rounded border border-cyan-500/20 bg-slate-900/40 hover:bg-cyan-500/10 hover:border-cyan-400/50 transition"
                >
                  <div className="flex items-center gap-2">
                    <c.icon className="w-4 h-4 text-cyan-300 shrink-0" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-cyan-100 truncate">{c.name}</div>
                      <div className="text-[10px] text-cyan-300/70 leading-snug">{c.note}</div>
                    </div>
                    <Pill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Pill>
                  </div>
                </button>
              ))}
            </div>
          </Card>

          {/* Memory */}
          <Card className="bg-slate-900/60 border-cyan-500/30 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-cyan-300" aria-hidden />
                <h3 className="text-xs tracking-widest text-cyan-200 uppercase">Persistent Memory</h3>
              </div>
              <span className="text-[9px] text-cyan-400/60 tracking-widest">{memory.length} FACTS</span>
            </div>
            <div className="flex gap-2 mb-2">
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="fact key (e.g. name)"
                aria-label="Memory key"
                className="flex-1 bg-slate-950/60 border border-cyan-500/30 rounded px-2 py-1 text-xs text-cyan-100 placeholder-cyan-500/40"
              />
              <input
                value={newVal}
                onChange={(e) => setNewVal(e.target.value)}
                placeholder="value"
                aria-label="Memory value"
                className="flex-1 bg-slate-950/60 border border-cyan-500/30 rounded px-2 py-1 text-xs text-cyan-100 placeholder-cyan-500/40"
              />
              <Button
                size="sm"
                variant="ghost"
                className="text-cyan-200 border border-cyan-500/40 h-7"
                onClick={() => {
                  if (!newKey.trim() || !newVal.trim()) return;
                  addMemory('identity', newKey.trim(), newVal.trim());
                  logReasoning('Memory', 'stored fact', `${newKey}: ${newVal}`, 1);
                  setNewKey('');
                  setNewVal('');
                }}
              >
                Add
              </Button>
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {memory.length === 0 && <div className="text-[11px] text-cyan-400/60 italic">No memories yet. Teach me anything about you.</div>}
              {memory.map((mem) => (
                <div key={mem.id} className="flex items-center justify-between text-xs bg-slate-950/40 rounded px-2 py-1">
                  <div className="min-w-0">
                    <span className="text-cyan-400/70 uppercase text-[9px] tracking-widest mr-2">{mem.category}</span>
                    <span className="text-cyan-100">{mem.key}:</span> <span className="text-cyan-300/90">{mem.value}</span>
                  </div>
                  <button onClick={() => removeMemory(mem.id)} aria-label={`Remove memory ${mem.key}`} className="text-cyan-500/50 hover:text-red-400 shrink-0 ml-2">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          {/* Reasoning log */}
          <Card className="bg-slate-900/60 border-cyan-500/30 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-cyan-300" aria-hidden />
                <h3 className="text-xs tracking-widest text-cyan-200 uppercase">Console routing log</h3>
              </div>
              {log.length > 0 && (
                <button onClick={clearLog} className="text-[9px] text-cyan-500/70 hover:text-cyan-300 tracking-widest uppercase">
                  Clear
                </button>
              )}
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto font-mono">
              {log.length === 0 && <div className="text-[11px] text-cyan-400/60 italic">No Console activity yet.</div>}
              {log.map((e) => (
                <div key={e.id} className="text-[10px] flex gap-2 text-cyan-100/80">
                  <span className="text-cyan-500/60">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="text-cyan-300">{e.agent}</span>
                  <span className="text-cyan-100/60">→</span>
                  <span className="flex-1 truncate">{e.action}{e.detail ? ` · ${e.detail}` : ''}</span>
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default MissionControl;
