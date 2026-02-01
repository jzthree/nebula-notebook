/**
 * ResourcePanel
 *
 * Compact dashboard panel showing system resources for all cluster servers.
 * Displays RAM and GPU usage with visual indicators.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Cpu, HardDrive, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { getClusterInfo } from '../services/clusterService';
import type { ClusterServer, GPUInfo } from '../services/clusterService';
import * as resourceService from '../services/resourceService';

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

interface Props {
  className?: string;
}

export const ResourcePanel: React.FC<Props> = ({ className = '' }) => {
  const [servers, setServers] = useState<ClusterServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-white rounded-xl border border-slate-200 p-4 ${className}`}>
        <div className="flex items-center gap-2 text-amber-600 text-sm">
          <AlertCircle className="w-4 h-4" />
          <span>Failed to load</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-white rounded-xl border border-slate-200 overflow-hidden ${className}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <HardDrive className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-medium text-slate-700">Resources</h3>
      </div>

      {/* Content - scrollable if many servers */}
      <div className="max-h-[280px] overflow-y-auto divide-y divide-slate-100">
        {servers.map((server) => (
          <ServerResourceRow key={server.id} server={server} />
        ))}
      </div>
    </div>
  );
};

// Compact server resource row
const ServerResourceRow: React.FC<{ server: ClusterServer }> = ({ server }) => {
  const [expanded, setExpanded] = useState(false);
  const resources = server.resources;
  const isOnline = server.status === 'online';

  // Server display name
  const displayName = resources?.hostname || server.name || server.id;

  if (!resources) {
    return (
      <div className="px-4 py-2.5 flex items-center justify-between text-sm">
        <span className="text-slate-700">{displayName}</span>
        <span className="text-xs text-slate-400">No data</span>
      </div>
    );
  }

  const ramPercent = resources.ram.total > 0
    ? (resources.ram.used / resources.ram.total) * 100
    : 0;

  const hasGpus = resources.gpus && resources.gpus.devices.length > 0;
  const gpuCount = resources.gpus?.devices.length || 0;

  return (
    <div className={`px-4 py-2.5 ${!isOnline ? 'opacity-50' : ''}`}>
      {/* Server name row */}
      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1.5">
        {hasGpus && gpuCount > 1 ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 hover:text-slate-700"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span className="font-medium text-slate-700">{displayName}</span>
          </button>
        ) : (
          <span className="font-medium text-slate-700">{displayName}</span>
        )}
      </div>

      {/* RAM row */}
      <div className="flex items-center gap-2 mb-1">
        <Cpu className="w-3 h-3 text-slate-400 flex-shrink-0" />
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${Math.min(ramPercent, 100)}%` }}
          />
        </div>
        <span className="text-xs text-slate-500 tabular-nums flex-shrink-0">
          {Math.round(resources.ram.used)}/{Math.round(resources.ram.total)} GB
        </span>
      </div>

      {/* GPU summary or details */}
      {hasGpus && (
        <GPUSummary gpus={resources.gpus!} expanded={expanded || gpuCount === 1} />
      )}
    </div>
  );
};

// GPU summary - compact view with optional expansion
const GPUSummary: React.FC<{ gpus: GPUInfo; expanded: boolean }> = ({ gpus, expanded }) => {
  const percent = gpus.totalMemory > 0
    ? (gpus.totalUsed / gpus.totalMemory) * 100
    : 0;

  // Get short name from first GPU, handle "AMD GPU X" default names
  const firstName = gpus.devices[0]?.name || '';
  const isDefaultName = firstName.match(/^(AMD |NVIDIA )?GPU \d+$/i);
  const shortName = isDefaultName
    ? (gpus.vendor === 'amd' ? 'AMD' : 'GPU')
    : firstName
        .replace(/NVIDIA |AMD |GeForce |Radeon /gi, '')
        .replace(/RTX |GTX /gi, '')
        .split('-')[0]
        .split(' ')[0]
        .trim() || 'GPU';

  if (!expanded) {
    // Collapsed view - show summary with total memory
    return (
      <div className="flex items-center gap-2">
        <GpuIcon className="w-3 h-3 text-slate-400 flex-shrink-0" />
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
        <span className="text-xs text-slate-500 tabular-nums flex-shrink-0">
          {gpus.devices.length}x {shortName} {Math.round(gpus.totalUsed)}/{Math.round(gpus.totalMemory)} GB
        </span>
      </div>
    );
  }

  // Expanded view - show each GPU
  return (
    <div className="space-y-1">
      {gpus.devices.map((gpu) => {
        const gpuPercent = gpu.memoryTotal > 0
          ? (gpu.memoryUsed / gpu.memoryTotal) * 100
          : 0;

        return (
          <div key={gpu.index} className="flex items-center gap-2">
            <GpuIcon className="w-3 h-3 text-slate-400 flex-shrink-0" />
            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${Math.min(gpuPercent, 100)}%` }}
              />
            </div>
            <span className="text-xs text-slate-500 tabular-nums flex-shrink-0" title={gpu.name}>
              {Math.round(gpu.memoryUsed)}/{Math.round(gpu.memoryTotal)} GB
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default ResourcePanel;
