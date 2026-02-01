/**
 * ResourcePanel
 *
 * Horizontal dashboard panel showing system resources for all cluster servers.
 * Designed for bottom placement with horizontal expansion for large clusters.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { HardDrive, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { getClusterInfo } from '../services/clusterService';
import type { ClusterServer, GPUInfo, GPUDevice } from '../services/clusterService';

const POLL_INTERVAL_MS = 30_000; // 30 seconds

// GPU icon as inline SVG
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

// RAM icon
const RamIcon: React.FC<{ className?: string }> = ({ className }) => (
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
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <line x1="6" y1="10" x2="6" y2="14" />
    <line x1="10" y1="10" x2="10" y2="14" />
    <line x1="14" y1="10" x2="14" y2="14" />
    <line x1="18" y1="10" x2="18" y2="14" />
  </svg>
);

interface Props {
  className?: string;
}

export const ResourcePanel: React.FC<Props> = ({ className = '' }) => {
  const [servers, setServers] = useState<ClusterServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const fetchClusterInfo = useCallback(async () => {
    try {
      const info = await getClusterInfo();
      setServers(info.servers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch cluster info');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClusterInfo();
    const interval = setInterval(fetchClusterInfo, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchClusterInfo]);

  if (isLoading) {
    return (
      <div className={`bg-white rounded-xl border border-slate-200 p-4 ${className}`}>
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <HardDrive className="w-4 h-4 animate-pulse" />
          <span>Loading resources...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-white rounded-xl border border-slate-200 p-4 ${className}`}>
        <div className="flex items-center gap-2 text-amber-600 text-sm">
          <AlertCircle className="w-4 h-4" />
          <span>Failed to load resources</span>
        </div>
      </div>
    );
  }

  // Check if any server has GPUs
  const hasAnyGpus = servers.some(s => s.resources?.gpus && s.resources.gpus.devices.length > 0);
  const totalGpuCount = servers.reduce((sum, s) => sum + (s.resources?.gpus?.devices.length || 0), 0);

  return (
    <div className={`bg-white rounded-xl border border-slate-200 overflow-hidden ${className}`}>
      {/* Header with expand toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2.5 border-b border-slate-100 flex items-center justify-between hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-medium text-slate-700">System Resources</h3>
          <span className="text-xs text-slate-400">
            {servers.length} server{servers.length !== 1 ? 's' : ''}
            {hasAnyGpus && ` · ${totalGpuCount} GPU${totalGpuCount !== 1 ? 's' : ''}`}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-slate-400" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-400" />
        )}
      </button>

      {/* Collapsed view - compact summary */}
      {!expanded && (
        <div className="px-4 py-3 flex flex-wrap gap-4">
          {servers.map((server) => (
            <ServerCompactView key={server.id} server={server} />
          ))}
        </div>
      )}

      {/* Expanded view - detailed info */}
      {expanded && (
        <div className="p-4">
          <div className="flex flex-wrap gap-4">
            {servers.map((server) => (
              <ServerExpandedView key={server.id} server={server} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Compact server view (collapsed state)
const ServerCompactView: React.FC<{ server: ClusterServer }> = ({ server }) => {
  const resources = server.resources;
  const isOnline = server.status === 'online';
  const displayName = resources?.hostname || server.name || server.id;

  if (!resources) {
    return (
      <div className={`flex items-center gap-2 text-xs ${!isOnline ? 'opacity-50' : ''}`}>
        <span className="font-medium text-slate-600">{displayName}</span>
        <span className="text-slate-400">—</span>
      </div>
    );
  }

  const ramPercent = resources.ram.total > 0
    ? (resources.ram.used / resources.ram.total) * 100
    : 0;

  const hasGpus = resources.gpus && resources.gpus.devices.length > 0;
  const gpuPercent = hasGpus && resources.gpus!.totalMemory > 0
    ? (resources.gpus!.totalUsed / resources.gpus!.totalMemory) * 100
    : 0;

  // Get short GPU name
  const gpuShortName = hasGpus ? getGpuShortName(resources.gpus!) : '';

  return (
    <div className={`flex items-center gap-3 ${!isOnline ? 'opacity-50' : ''}`}>
      {/* Server name */}
      <span className="text-xs font-medium text-slate-600 min-w-[60px]">{displayName}</span>

      {/* RAM mini bar */}
      <div className="flex items-center gap-1.5">
        <RamIcon className="w-3 h-3 text-slate-400" />
        <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${Math.min(ramPercent, 100)}%` }}
          />
        </div>
        <span className="text-[10px] text-slate-400 tabular-nums w-8">{Math.round(ramPercent)}%</span>
      </div>

      {/* GPU mini bar */}
      {hasGpus && (
        <div className="flex items-center gap-1.5">
          <GpuIcon className="w-3 h-3 text-slate-400" />
          <span className="text-[10px] text-slate-500">{resources.gpus!.devices.length}x</span>
          <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${Math.min(gpuPercent, 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-slate-400 tabular-nums w-8">{Math.round(gpuPercent)}%</span>
        </div>
      )}
    </div>
  );
};

// Expanded server view with individual GPU bars
const ServerExpandedView: React.FC<{ server: ClusterServer }> = ({ server }) => {
  const resources = server.resources;
  const isOnline = server.status === 'online';
  const displayName = resources?.hostname || server.name || server.id;

  if (!resources) {
    return (
      <div className={`bg-slate-50 rounded-lg p-3 min-w-[200px] ${!isOnline ? 'opacity-50' : ''}`}>
        <div className="text-xs font-medium text-slate-600 mb-2">{displayName}</div>
        <div className="text-xs text-slate-400">No data available</div>
      </div>
    );
  }

  const ramPercent = resources.ram.total > 0
    ? (resources.ram.used / resources.ram.total) * 100
    : 0;

  const hasGpus = resources.gpus && resources.gpus.devices.length > 0;
  const gpuShortName = hasGpus ? getGpuShortName(resources.gpus!) : '';

  return (
    <div className={`bg-slate-50 rounded-lg p-3 min-w-[280px] ${!isOnline ? 'opacity-50' : ''}`}>
      {/* Server name and GPU type */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-slate-700">{displayName}</span>
        {hasGpus && (
          <span className="text-[10px] text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded">
            {resources.gpus!.devices.length}x {gpuShortName}
          </span>
        )}
      </div>

      {/* RAM */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <div className="flex items-center gap-1">
            <RamIcon className="w-3 h-3" />
            <span>RAM</span>
          </div>
          <span className="tabular-nums">{Math.round(resources.ram.used)}/{Math.round(resources.ram.total)} GB</span>
        </div>
        <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${Math.min(ramPercent, 100)}%` }}
          />
        </div>
      </div>

      {/* GPUs - horizontal bars */}
      {hasGpus && (
        <div className="space-y-1.5">
          {resources.gpus!.devices.map((gpu) => (
            <GpuBar key={gpu.index} gpu={gpu} />
          ))}
        </div>
      )}
    </div>
  );
};

// Individual GPU bar
const GpuBar: React.FC<{ gpu: GPUDevice }> = ({ gpu }) => {
  const percent = gpu.memoryTotal > 0
    ? (gpu.memoryUsed / gpu.memoryTotal) * 100
    : 0;

  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-slate-500 mb-0.5">
        <div className="flex items-center gap-1">
          <GpuIcon className="w-3 h-3" />
          <span>GPU {gpu.index}</span>
        </div>
        <span className="tabular-nums">{Math.round(gpu.memoryUsed)}/{Math.round(gpu.memoryTotal)} GB</span>
      </div>
      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
};

// Get short GPU name from GPU info
function getGpuShortName(gpus: GPUInfo): string {
  const firstName = gpus.devices[0]?.name || '';
  const isDefaultName = firstName.match(/^(AMD |NVIDIA )?GPU \d+$/i);

  if (isDefaultName) {
    return gpus.vendor === 'amd' ? 'AMD' : 'GPU';
  }

  // Extract model name: "AMD Instinct MI300X" -> "MI300X"
  // "NVIDIA GeForce RTX 4090" -> "4090"
  return firstName
    .replace(/NVIDIA |AMD |GeForce |Radeon |Instinct /gi, '')
    .replace(/RTX |GTX /gi, '')
    .split('-')[0]
    .split(' ')[0]
    .trim() || 'GPU';
}

export default ResourcePanel;
