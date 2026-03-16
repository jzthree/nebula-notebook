/**
 * ResourceStatusBar
 *
 * Compact status bar showing RAM and GPU memory usage.
 * Used in the notebook header to show resources of the kernel server.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Cpu, HardDrive, AlertCircle, RefreshCw } from 'lucide-react';
import * as resourceService from '../services/resourceService';
import type { ServerResources, GPUDevice } from '../services/resourceService';

interface Props {
  serverId?: string;  // If provided, shows resources for specific server (for remote kernels)
  className?: string;
}

// GPU icon as inline SVG (lucide doesn't have a GPU icon)
const GpuIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect x="4" y="6" width="16" height="12" rx="2" />
    <rect x="8" y="10" width="3" height="4" />
    <rect x="13" y="10" width="3" height="4" />
    <line x1="2" y1="10" x2="4" y2="10" />
    <line x1="2" y1="14" x2="4" y2="14" />
    <line x1="20" y1="10" x2="22" y2="10" />
    <line x1="20" y1="14" x2="22" y2="14" />
  </svg>
);

const POLL_INTERVAL_MS = 30_000; // 30 seconds

export const ResourceStatusBar: React.FC<Props> = ({ serverId, className = '' }) => {
  const [resources, setResources] = useState<ServerResources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchResources = useCallback(async () => {
    try {
      const data = await resourceService.getResources(serverId);
      setResources(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch resources');
    }
  }, [serverId]);

  useEffect(() => {
    fetchResources();
    const interval = setInterval(fetchResources, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchResources]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const data = await resourceService.refreshResources();
      setResources(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh');
    }
    setIsRefreshing(false);
  };

  if (error) {
    return (
      <div className={`flex items-center gap-1.5 text-xs text-amber-600 ${className}`}>
        <AlertCircle className="w-3.5 h-3.5" />
        <span>Resources unavailable</span>
      </div>
    );
  }

  if (!resources) {
    return (
      <div className={`flex items-center gap-1.5 text-xs text-slate-400 ${className}`}>
        <HardDrive className="w-3.5 h-3.5 animate-pulse" />
        <span>Loading...</span>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 text-xs overflow-hidden flex-nowrap min-w-0 ${className}`}>
      {/* RAM */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <Cpu className="w-3.5 h-3.5 text-slate-500" />
        <span className="text-slate-600 font-medium tabular-nums">
          {resourceService.formatMemory(resources.ram.used)} / {resourceService.formatMemory(resources.ram.total)}
        </span>
        <span className="text-slate-400">RAM</span>
      </div>

      {/* GPU(s) — overflow hidden, never wraps */}
      {resources.gpus && resources.gpus.devices.length > 0 && (
        <div className="flex items-center gap-2 overflow-hidden flex-nowrap min-w-0">
          {resources.gpus.devices.map((gpu) => (
            <GPUIndicator key={gpu.index} gpu={gpu} vendor={resources.gpus!.vendor} />
          ))}
        </div>
      )}

      {/* GPU Error */}
      {resources.gpuError && (
        <div className="flex items-center gap-1.5 text-slate-400 flex-shrink-0" title={`GPU: ${resources.gpuError}`}>
          <GpuIcon className="w-3.5 h-3.5" />
          <span>--</span>
        </div>
      )}

      {/* Refresh button */}
      <button
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0"
        title="Refresh resources"
      >
        <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
      </button>

      {/* Stale indicator */}
      {resources.isStale && (
        <span className="text-amber-500 flex-shrink-0" title="Data may be outdated">*</span>
      )}
    </div>
  );
};

// Individual GPU indicator
const GPUIndicator: React.FC<{ gpu: GPUDevice; vendor: 'nvidia' | 'amd' }> = ({ gpu }) => {
  const percent = gpu.memoryTotal > 0 ? Math.round((gpu.memoryUsed / gpu.memoryTotal) * 100) : 0;
  const tooltip = [
    gpu.name,
    `${resourceService.formatMemory(gpu.memoryUsed)} / ${resourceService.formatMemory(gpu.memoryTotal)} (${percent}%)`,
    gpu.temperature ? `${gpu.temperature}°C` : null,
    gpu.utilization !== undefined ? `${gpu.utilization}% util` : null,
  ].filter(Boolean).join(' • ');

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0" title={tooltip}>
      <GpuIcon className="w-3.5 h-3.5 text-emerald-600" />
      <span className="text-slate-400 text-[0.625rem]">GPU {gpu.index}</span>
      <div className="h-1.5 w-16 rounded-full bg-slate-200 overflow-hidden">
        <div
          className="h-full bg-emerald-500"
          style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
        />
      </div>
      <span className="text-slate-500 text-[0.625rem] tabular-nums">{percent}%</span>
    </div>
  );
};

export default ResourceStatusBar;
