/**
 * Compute Dashboard Card
 *
 * Shown on the default screen only when a scheduler (SLURM etc.) is detected.
 * Gives an at-a-glance queue monitor (per-partition idle capacity + backlog)
 * and live allocation management, with a button into the full allocation modal.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Cpu, Loader2, Trash2, RefreshCw, Plus, Server } from 'lucide-react';
import ComputeAllocationModal from './ComputeAllocationModal';
import {
  getComputeStatus,
  getComputePartitions,
  listAllocations,
  cancelAllocation,
  type Allocation,
  type PartitionLoad,
} from '../services/computeService';

const STATE_BADGE: Record<Allocation['state'], string> = {
  pending: 'bg-amber-100 text-amber-700',
  running: 'bg-blue-100 text-blue-700',
  active: 'bg-green-100 text-green-700',
  ended: 'bg-slate-100 text-slate-500',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
};

const ACTIVE_STATES: Allocation['state'][] = ['pending', 'running', 'active'];

/** Short GPU label for the inline chip: strip the vendor prefix, keep the model
 *  token (e.g. "nvidia_<model>-<mem>gb" -> "<MODEL>"). */
function gpuShort(type: string): string {
  return type.replace(/^nvidia[_-]?/i, '').split(/[-_]/)[0].toUpperCase() || 'GPU';
}
/** Readable GPU type for the hover tooltip: strip the vendor prefix, uppercase. */
function gpuFull(type: string): string {
  return type.replace(/^nvidia[_-]?/i, '').toUpperCase();
}

export default function ComputeDashboardCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [partitions, setPartitions] = useState<PartitionLoad[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [showModal, setShowModal] = useState(false);

  const refreshAllocations = useCallback(async () => {
    try {
      setAllocations(await listAllocations());
    } catch {
      /* keep last */
    }
  }, []);

  const refreshLoad = useCallback(async () => {
    try {
      const data = await getComputePartitions();
      setPartitions(data.load?.partitions ?? []);
      setAllowed(data.associations?.partitions ?? []);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getComputeStatus()
      .then((s) => {
        if (cancelled) return;
        setEnabled(!!s.enabled);
        if (s.enabled) { refreshAllocations(); refreshLoad(); }
      })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, [refreshAllocations, refreshLoad]);

  // Allocation state is cheap (in-memory list) — poll it often so pending →
  // running → active transitions show up quickly.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(refreshAllocations, 4000);
    return () => clearInterval(id);
  }, [enabled, refreshAllocations]);

  // The queue-load snapshot hits the scheduler (sinfo/scontrol/squeue) — poll slowly.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(refreshLoad, 15000);
    return () => clearInterval(id);
  }, [enabled, refreshLoad]);

  if (!enabled) return null; // hidden unless a scheduler is detected

  const handleCancel = async (id: string) => {
    try { await cancelAllocation(id); await refreshAllocations(); } catch { /* toast handled elsewhere */ }
  };

  // Queue monitor: all allowed partitions with a load snapshot, most-idle first.
  const allowedSet = new Set(allowed.map((p) => p.toLowerCase()));
  const queue = partitions
    .filter((p) => allowedSet.size === 0 || allowedSet.has(p.name.toLowerCase()))
    .sort((a, b) => b.cpus.idle - a.cpus.idle);

  const activeAllocs = allocations.filter((a) => ACTIVE_STATES.includes(a.state));

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <Cpu className="w-4 h-4 text-blue-600" />
        <h3 className="text-sm font-medium text-slate-700">Compute</h3>
        <div className="flex-1" />
        <button
          onClick={() => { refreshAllocations(); refreshLoad(); }}
          className="p-1 rounded hover:bg-slate-100 text-slate-400"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-1 px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium"
        >
          <Plus className="w-3.5 h-3.5" /> New
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* Allocations */}
        <div>
          <div className="text-[0.625rem] font-semibold text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1">
            <Server className="w-3 h-3" /> Allocations
            {activeAllocs.length > 0 && (
              <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" title="Auto-refreshing" />
            )}
          </div>
          {activeAllocs.length === 0 ? (
            <div className="text-xs text-slate-400 py-1">None running. Click <span className="font-medium">New</span> to request compute.</div>
          ) : (
            <div className="space-y-1">
              {activeAllocs.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-xs">
                  <span className={`px-1.5 py-0.5 rounded font-medium ${STATE_BADGE[a.state]}`}>{a.state}</span>
                  <span className="text-slate-600 truncate">
                    {a.spec.partition}{a.spec.qos ? `/${a.spec.qos}` : ''} · {a.spec.cpus}cpu
                    {a.nodes?.length ? ` · ${a.nodes[0]}` : ''}
                  </span>
                  <div className="flex-1" />
                  <button
                    onClick={() => handleCancel(a.id)}
                    className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"
                    title="Cancel"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Queue monitor */}
        <div>
          <div className="text-[0.625rem] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
            Queue load{queue.length ? '' : ' (loading…)'}
          </div>
          {queue.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-slate-400 py-1">
              <Loader2 className="w-3 h-3 animate-spin" /> reading scheduler…
            </div>
          ) : (
            <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
              {queue.flatMap((p) => {
                // GPU queues headline their idle GPUs — one row per GPU model
                // (heterogeneous queues mix cards); everything else, idle CPUs.
                const rows: { key: string; gpu: { type: string; total: number; idle: number } | null; showName: boolean }[] =
                  p.gpus?.length
                    ? p.gpus.map((g, i) => ({ key: `${p.name}:${g.type}`, gpu: g, showName: i === 0 }))
                    : [{ key: p.name, gpu: null, showName: true }];
                return rows.map(({ key, gpu, showName }) => {
                const idle = gpu ? gpu.idle : p.cpus.idle;
                const total = gpu ? gpu.total : p.cpus.total;
                const pct = Math.round((idle / (total || 1)) * 100);
                const title = [
                  p.name,
                  gpu ? `GPUs: ${gpu.idle}/${gpu.total} idle (${gpuFull(gpu.type)})` : null,
                  `CPUs: ${p.cpus.idle}/${p.cpus.total} idle`,
                  `Nodes: ${p.nodes.idle}/${p.nodes.total} idle`,
                  p.timeLimit ? `Max walltime: ${p.timeLimit}` : null,
                  `Queue: ${p.jobs.pending} pending, ${p.jobs.running} running`,
                ].filter(Boolean).join('\n');
                return (
                  <div key={key} title={title} className="flex items-center gap-2 text-xs py-0.5">
                    <span className={`font-medium truncate w-14 flex-shrink-0 ${showName ? 'text-slate-600' : 'text-transparent select-none'}`}>{p.name}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden min-w-[1.5rem]">
                      <div
                        className={`h-full ${pct > 25 ? 'bg-green-400' : pct > 5 ? 'bg-amber-400' : 'bg-red-400'}`}
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                    {gpu && (
                      <span className="px-1 py-px rounded bg-violet-100 text-violet-700 text-[0.5625rem] font-medium leading-none whitespace-nowrap flex-shrink-0">
                        {gpuShort(gpu.type)}
                      </span>
                    )}
                    <span className="text-slate-500 tabular-nums text-[0.6875rem] whitespace-nowrap flex-shrink-0">
                      {idle}<span className="text-slate-300">/{total}</span>
                      <span className="text-slate-400 ml-0.5">{gpu ? 'gpu' : 'cpu'}</span>
                    </span>
                  </div>
                );
                });
              })}
            </div>
          )}
        </div>
      </div>

      <ComputeAllocationModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onChanged={refreshAllocations}
      />
    </div>
  );
}
