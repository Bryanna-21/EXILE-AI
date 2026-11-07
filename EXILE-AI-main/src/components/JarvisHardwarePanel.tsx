import { useEffect, useRef, useState } from 'react';

const API = 'http://127.0.0.1:8787';

type Drive = {
  drive?: string;
  totalGB?: number;
  freeGB?: number;
  usedPercent?: number;
};

type Battery = {
  name?: string;
  chargePercent?: number;
  statusCode?: number;
  healthPercent?: number;
};

type NetworkRate = {
  downloadMbps: number | null;
  uploadMbps: number | null;
  available: boolean;
};

type PreviousNetworkSample = {
  timestampMs: number;
  counters: Record<string, {
    receivedBytes: number | null;
    sentBytes: number | null;
  }>;
};

function batteryState(statusCode?: number): string {
  switch (statusCode) {
    case 1: return 'Discharging';
    case 2: return 'On AC power';
    case 3: return 'Fully charged';
    case 4: return 'Low battery';
    case 5: return 'Critical battery';
    case 6:
    case 7:
    case 8:
    case 9: return 'Charging';
    case 11: return 'Partially charged';
    default: return 'Unknown';
  }
}

function formatMbps(rate: NetworkRate | undefined, direction: 'download' | 'upload'): string {
  if (!rate) return 'Sampling…';
  if (!rate.available) return 'Unavailable';

  const value = direction === 'download'
    ? rate.downloadMbps
    : rate.uploadMbps;

  if (value === null) return 'Sampling…';
  if (value < 0.01) return '<0.01 Mbps';
  return `${value.toFixed(2)} Mbps`;
}

type FirewallProfile = {
  profile?: string;
  enabled?: boolean;
};

type Snapshot = {
  timestamp?: string;
  platform?: {
    os?: string;
    version?: string;
    lastBoot?: string;
  };
  memory?: {
    totalGB?: number;
    usedGB?: number;
    availableGB?: number;
    usedPercent?: number;
  };
  cpu?: {
    name?: string;
    loadPercent?: number;
    logicalProcessors?: number;
  };
  batteries?: Battery[];
  storage?: Drive[];
  networkAdapters?: Array<{
    name?: string;
    description?: string;
    status?: string;
    linkSpeed?: string;
    macAddress?: string;
    receivedBytes?: number | null;
    sentBytes?: number | null;
  }>;
  bluetoothDevices?: Array<{
    name?: string;
    status?: string;
    class?: string;
  }>;
  security?: {
    firewallProfiles?: FirewallProfile[];
    defender?: {
      available?: boolean;
      antivirusEnabled?: boolean;
      realTimeProtectionEnabled?: boolean;
      signatureLastUpdated?: string;
    };
  };
  topMemoryProcesses?: Array<{
    name?: string;
    pid?: number;
    memoryMB?: number;
    cpuSeconds?: number;
    responding?: boolean;
  }>;
};

type SystemResponse = {
  ok?: boolean;
  mode?: string;
  snapshot?: Snapshot;
  freshness?: {
    sampledAt?: string | null;
    ageMs?: number;
    stale?: boolean;
    refreshing?: boolean;
  };
};

function display(value: unknown, suffix = ''): string {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  return `${value}${suffix}`;
}

function percent(value?: number): string {
  return typeof value === 'number' ? `${Math.round(value)}%` : 'Unavailable';
}

function HardwareRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-white/5 py-1.5 last:border-0">
      <span className="text-[10px] text-slate-500">{label}</span>
      <span className="max-w-[62%] break-words text-right text-[10px] font-medium text-slate-200">
        {value}
      </span>
    </div>
  );
}

function UsageMeter({
  label,
  value,
  warningAt = 75,
  criticalAt = 90,
}: {
  label: string;
  value?: number;
  warningAt?: number;
  criticalAt?: number;
}) {
  const valid = typeof value === 'number' && Number.isFinite(value);
  const level =
    valid && value >= criticalAt
      ? 'critical'
      : valid && value >= warningAt
        ? 'warning'
        : 'normal';

  const barColor =
    level === 'critical'
      ? 'bg-red-400'
      : level === 'warning'
        ? 'bg-amber-400'
        : 'bg-cyan-400';

  const textColor =
    level === 'critical'
      ? 'text-red-300'
      : level === 'warning'
        ? 'text-amber-300'
        : 'text-slate-200';

  const width = valid ? Math.min(100, Math.max(0, value)) : 0;

  return (
    <div className="border-b border-white/5 py-1.5 last:border-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] text-slate-500">{label}</span>
        <span className={`text-[10px] font-semibold ${textColor}`}>
          {valid ? `${Math.round(value)}%` : 'Unavailable'}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-slate-700/80"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valid ? width : undefined}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${barColor}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

export default function JarvisHardwarePanel() {
  const [data, setData] = useState<SystemResponse | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [networkRates, setNetworkRates] = useState<Record<string, NetworkRate>>({});
  const previousNetworkSample = useRef<PreviousNetworkSample | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller = new AbortController();

      try {
        const response = await fetch(`${API}/arc/system`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`ARC returned HTTP ${response.status}`);
        }

        const result = (await response.json()) as SystemResponse;
        if (!result.snapshot) throw new Error('ARC has not supplied a hardware snapshot');

        if (active) {
          setData(result);
          setError('');
          setRefreshing(Boolean(result.freshness?.refreshing));

          const timestampValue = result.freshness?.sampledAt ?? result.snapshot.timestamp;
          const timestampMs = timestampValue
            ? new Date(timestampValue).getTime()
            : Date.now();

          const previous = previousNetworkSample.current;

          if (
            Number.isFinite(timestampMs) &&
            (!previous || timestampMs > previous.timestampMs)
          ) {
            const adapters = result.snapshot.networkAdapters ?? [];
            const nextCounters: PreviousNetworkSample['counters'] = {};
            const nextRates: Record<string, NetworkRate> = {};
            const elapsedSeconds = previous
              ? (timestampMs - previous.timestampMs) / 1000
              : 0;

            adapters.forEach((adapter, index) => {
              const key = (
                adapter.name?.trim() ||
                adapter.description?.trim() ||
                `adapter-${index}`
              );

              const receivedBytes = adapter.receivedBytes;
              const sentBytes = adapter.sentBytes;

              const validReceived =
                typeof receivedBytes === 'number' &&
                Number.isFinite(receivedBytes) &&
                receivedBytes >= 0;

              const validSent =
                typeof sentBytes === 'number' &&
                Number.isFinite(sentBytes) &&
                sentBytes >= 0;

              nextCounters[key] = {
                receivedBytes: validReceived ? receivedBytes : null,
                sentBytes: validSent ? sentBytes : null,
              };

              const old = previous?.counters[key];
              const countersAvailable =
                validReceived &&
                validSent &&
                old?.receivedBytes !== null &&
                old?.receivedBytes !== undefined &&
                old?.sentBytes !== null &&
                old?.sentBytes !== undefined;

              if (!previous) {
                nextRates[key] = {
                  downloadMbps: null,
                  uploadMbps: null,
                  available: validReceived && validSent,
                };
              } else if (!countersAvailable || elapsedSeconds <= 0) {
                nextRates[key] = {
                  downloadMbps: null,
                  uploadMbps: null,
                  available: false,
                };
              } else {
                const receivedDelta = receivedBytes! - old.receivedBytes!;
                const sentDelta = sentBytes! - old.sentBytes!;

                if (receivedDelta < 0 || sentDelta < 0) {
                  nextRates[key] = {
                    downloadMbps: null,
                    uploadMbps: null,
                    available: false,
                  };
                } else {
                  nextRates[key] = {
                    downloadMbps: (receivedDelta * 8) / elapsedSeconds / 1_000_000,
                    uploadMbps: (sentDelta * 8) / elapsedSeconds / 1_000_000,
                    available: true,
                  };
                }
              }
            });

            previousNetworkSample.current = {
              timestampMs,
              counters: nextCounters,
            };

            setNetworkRates(nextRates);
          }
        }
      } catch (err) {
        if (active && !(err instanceof Error && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : 'Hardware telemetry unavailable');
          setRefreshing(false);
        }
      } finally {
        if (active) {
          timer = setTimeout(poll, 15000);
        }
      }
    };

    void poll();

    return () => {
      active = false;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const snapshot = data?.snapshot;
  const memory = snapshot?.memory;
  const cpu = snapshot?.cpu;
  const drive =
    snapshot?.storage?.find((item) => item.drive?.toUpperCase().startsWith('C:')) ??
    snapshot?.storage?.[0];
  const battery = snapshot?.batteries?.[0];
  const defender = snapshot?.security?.defender;
  const firewallProfiles = snapshot?.security?.firewallProfiles ?? [];
  const firewallKnown = firewallProfiles.length > 0;
  const firewallEnabled =
    firewallKnown && firewallProfiles.some((profile) => profile.enabled === true);
  const sampledAt = data?.freshness?.sampledAt ?? snapshot?.timestamp;

  const status = error
    ? 'STALE'
    : !snapshot
      ? 'CONNECTING'
      : data?.freshness?.stale
        ? 'STALE'
        : 'LIVE';

  return (
    <section className="space-y-2 rounded-xl border border-cyan-500/20 bg-slate-900/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.7)]" />
          <h3 className="text-[10px] font-semibold tracking-[0.16em] text-cyan-300">
            HARDWARE STATUS
          </h3>
        </div>
        <span
          className={`text-[9px] font-bold tracking-wider ${
            status === 'LIVE'
              ? 'text-emerald-400'
              : status === 'STALE'
                ? 'text-amber-400'
                : 'text-slate-500'
          }`}
        >
          {status}
        </span>
      </div>

      {!snapshot && (
        <p className="text-[10px] text-slate-500">
          Waiting for ARC hardware telemetry…
        </p>
      )}

      {snapshot && (
        <div className="space-y-1">
          <HardwareRow label="PROCESSOR" value={display(cpu?.name)} />
          <UsageMeter label="CPU LOAD" value={cpu?.loadPercent} />
          <UsageMeter
            label="MEMORY USAGE"
            value={memory?.usedPercent}
            warningAt={85}
            criticalAt={90}
          />
          <HardwareRow
            label="RAM IN USE"
            value={
              typeof memory?.usedGB === 'number' &&
              typeof memory?.totalGB === 'number'
                ? `${memory.usedGB.toFixed(1)} / ${memory.totalGB.toFixed(1)} GB`
                : 'Unavailable'
            }
          />
          <HardwareRow
            label="SYSTEM DRIVE"
            value={
              drive
                ? `${display(drive.drive)} · ${display(drive.freeGB?.toFixed(1), ' GB free')}`
                : 'Unavailable'
            }
          />
          <HardwareRow
            label="BATTERY"
            value={battery ? `${percent(battery.chargePercent)} · ${batteryState(battery.statusCode)}` : 'Not detected'}
          />
          <HardwareRow
            label="DEFENDER"
            value={
              defender?.available === false
                ? 'Unavailable'
                : defender?.realTimeProtectionEnabled === true
                  ? 'Real-time protection ON'
                  : defender?.realTimeProtectionEnabled === false
                    ? 'Real-time protection OFF'
                    : 'Unknown'
            }
          />
          <HardwareRow
            label="FIREWALL"
            value={
              !firewallKnown
                ? 'Unknown'
                : firewallEnabled
                  ? 'At least one profile ON'
                  : 'All reported profiles OFF'
            }
          />
        </div>
      )}

      {typeof memory?.usedPercent === 'number' &&
        Number.isFinite(memory.usedPercent) &&
        memory.usedPercent >= 85 && (
          <div
            className={`rounded-lg border p-2 ${
              memory.usedPercent >= 90
                ? 'border-red-500/30 bg-red-500/10'
                : 'border-amber-500/30 bg-amber-500/10'
            }`}
          >
            <p
              className={`text-[10px] font-semibold ${
                memory.usedPercent >= 90 ? 'text-red-300' : 'text-amber-300'
              }`}
            >
              {memory.usedPercent >= 90
                ? 'CRITICAL MEMORY PRESSURE'
                : 'HIGH MEMORY USAGE'}
            </p>
            <p className="mt-1 text-[10px] text-slate-400">
              RAM usage is {Math.round(memory.usedPercent)}%. This is a
              monitoring warning only; no processes are stopped automatically.
            </p>
          </div>
        )}

      <details className="group border-t border-white/5 pt-2">
        <summary className="cursor-pointer list-none text-[10px] font-medium text-cyan-300 hover:text-cyan-200">
          View detailed specifications
          <span className="float-right text-slate-500 group-open:rotate-180">⌄</span>
        </summary>

        {snapshot && (
          <div className="mt-2 space-y-3">
            <div>
              <p className="mb-1 text-[9px] font-semibold tracking-wider text-slate-500">
                SYSTEM
              </p>
              <HardwareRow label="OPERATING SYSTEM" value={display(snapshot.platform?.os)} />
              <HardwareRow label="VERSION" value={display(snapshot.platform?.version)} />
              <HardwareRow
                label="LOGICAL PROCESSORS"
                value={display(cpu?.logicalProcessors)}
              />
              <HardwareRow label="LAST BOOT" value={display(snapshot.platform?.lastBoot)} />
            </div>

            <div>
              <p className="mb-1 text-[9px] font-semibold tracking-wider text-slate-500">
                STORAGE
              </p>
              {(snapshot.storage ?? []).length ? (
                snapshot.storage?.map((item, index) => (
                  <HardwareRow
                    key={`${item.drive ?? 'drive'}-${index}`}
                    label={display(item.drive)}
                    value={
                      typeof item.totalGB === 'number'
                        ? `${item.freeGB?.toFixed(1) ?? '?'} GB free / ${item.totalGB.toFixed(1)} GB`
                        : 'Unavailable'
                    }
                  />
                ))
              ) : (
                <HardwareRow label="DRIVES" value="Unavailable" />
              )}
            </div>

            <div>
              <p className="mb-1 text-[9px] font-semibold tracking-wider text-slate-500">
                BATTERY
              </p>
              {(snapshot.batteries ?? []).length ? (
                snapshot.batteries?.map((item, index) => (
                  <div key={`${item.name ?? 'battery'}-${index}`}>
                    <HardwareRow label="DEVICE" value={display(item.name)} />
                    <HardwareRow label="CHARGE" value={percent(item.chargePercent)} />
                    <HardwareRow label="POWER STATE" value={batteryState(item.statusCode)} />
                    <HardwareRow label="HEALTH" value={percent(item.healthPercent)} />
                  </div>
                ))
              ) : (
                <HardwareRow label="BATTERY" value="No battery detected" />
              )}
            </div>

            <div>
              <p className="mb-1 text-[9px] font-semibold tracking-wider text-slate-500">
                NETWORK ADAPTERS
              </p>
              {(snapshot.networkAdapters ?? []).length ? (
                snapshot.networkAdapters?.map((item, index) => (
                  <div key={`${item.name ?? 'adapter'}-${index}`}>
                    <HardwareRow label="ADAPTER" value={display(item.name)} />
                    <HardwareRow label="STATUS" value={display(item.status)} />
                    <HardwareRow label="LINK SPEED" value={display(item.linkSpeed)} />
                    <HardwareRow
                      label="DOWNLOAD"
                      value={formatMbps(
                        networkRates[item.name?.trim() || item.description?.trim() || `adapter-${index}`],
                        'download'
                      )}
                    />
                    <HardwareRow
                      label="UPLOAD"
                      value={formatMbps(
                        networkRates[item.name?.trim() || item.description?.trim() || `adapter-${index}`],
                        'upload'
                      )}
                    />
                  </div>
                ))
              ) : (
                <HardwareRow label="ADAPTERS" value="Unavailable" />
              )}
            </div>

            <div>
              <p className="mb-1 text-[9px] font-semibold tracking-wider text-slate-500">
                SECURITY
              </p>
              <HardwareRow
                label="ANTIVIRUS"
                value={
                  defender?.antivirusEnabled === true
                    ? 'Enabled'
                    : defender?.antivirusEnabled === false
                      ? 'Disabled'
                      : 'Unknown'
                }
              />
              <HardwareRow
                label="SIGNATURE UPDATE"
                value={display(defender?.signatureLastUpdated)}
              />
              {firewallProfiles.map((profile, index) => (
                <HardwareRow
                  key={`${profile.profile ?? 'profile'}-${index}`}
                  label={`${display(profile.profile)} FIREWALL`}
                  value={
                    profile.enabled === true
                      ? 'Enabled'
                      : profile.enabled === false
                        ? 'Disabled'
                        : 'Unknown'
                  }
                />
              ))}
            </div>

            <div>
              <p className="mb-1 text-[9px] font-semibold tracking-wider text-slate-500">
                TOP MEMORY PROCESSES
              </p>
              {(snapshot.topMemoryProcesses ?? []).slice(0, 5).map((process, index) => (
                <HardwareRow
                  key={`${process.pid ?? process.name ?? 'process'}-${index}`}
                  label={display(process.name)}
                  value={
                    typeof process.memoryMB === 'number'
                      ? `${process.memoryMB.toFixed(0)} MB`
                      : 'Unavailable'
                  }
                />
              ))}
            </div>
          </div>
        )}
      </details>

      <div className="flex items-center justify-between gap-2 border-t border-white/5 pt-2">
        <span className="text-[9px] text-slate-600">
          {sampledAt ? `Sample: ${new Date(sampledAt).toLocaleTimeString()}` : 'No sample yet'}
        </span>
        <span className="text-[9px] text-slate-600">
          {refreshing ? 'Refreshing…' : 'ARC · Read only'}
        </span>
      </div>

      {error && (
        <p className="break-words text-[9px] text-amber-400">
          Telemetry issue: {error}. Displaying the last available sample, if any.
        </p>
      )}
    </section>
  );
}
