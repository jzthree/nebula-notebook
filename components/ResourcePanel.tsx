/**
 * ResourcePanel
 *
 * Dashboard panel showing system resources for all cluster servers.
 * Displays RAM and GPU usage with visual indicators.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Cpu, HardDrive, AlertCircle, Thermometer } from 'lucide-react';
import { getClusterInfo } from '../services/clusterService';
import type { ClusterServer, GPUDevice } from '../services/clusterService';
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

  return (
    <div className={`bg-white rounded-xl border border-slate-200 overflow-hidden ${className}`}>
      {/* Header - matches other panels */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <HardDrive className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-medium text-slate-700">Resources</h3>
      </div>

      {/* Content */}
      <div className="divide-y divide-slate-100">
        {servers.map((server) => (
          <ServerResourceRow key={server.id} server={server} />
        ))}
      </div>
    </div>
  );
};

// Compact server resource row
const ServerResourceRow: React.FC<{ server: ClusterServer }> = ({ server }) => {
  const resources = server.resources;
  const isOnline = server.status === 'online';

  // Server display name - use hostname from resources if available
  const displayName = resources?.hostname || server.name || server.id;

  if (!resources) {
    return (
      <div className="px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-700">{displayName}</span>
          <span className="text-xs text-slate-400">No data</span>
        </div>
      </div>
    );
  }

  const ramPercent = resources.ram.total > 0
    ? (resources.ram.used / resources.ram.total) * 100
    : 0;

  return (
    <div className={`px-4 py-3 ${!isOnline ? 'opacity-50' : ''}`}>
      {/* Server name + RAM on same line for single server */}
      <div className="space-y-2">
        {/* RAM bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-slate-500">
              <Cpu className="w-3.5 h-3.5" />
              <span>{displayName}</span>
            </div>
            <span className="text-slate-600 tabular-nums">
              {resourceService.formatMemory(resources.ram.used)} / {resourceService.formatMemory(resources.ram.total)}
            </span>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${Math.min(ramPercent, 100)}%` }}
            />
          </div>
        </div>

        {/* GPUs */}
        {resources.gpus && resources.gpus.devices.map((gpu) => (
          <GPURow key={gpu.index} gpu={gpu} />
        ))}
      </div>
    </div>
  );
};

// Compact GPU row
const GPURow: React.FC<{ gpu: GPUDevice }> = ({ gpu }) => {
  const percent = gpu.memoryTotal > 0 ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : 0;

  // Short GPU name
  const shortName = gpu.name
    .replace(/NVIDIA |AMD |GeForce |Radeon /gi, '')
    .replace(/RTX |GTX /gi, '')
    .trim();

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-slate-500">
          <GpuIcon className="w-3.5 h-3.5" />
          <span className="truncate max-w-[100px]" title={gpu.name}>
            {shortName}
          </span>
          {gpu.temperature !== undefined && (
            <span className="flex items-center gap-0.5 text-slate-400">
              <Thermometer className="w-3 h-3" />
              {gpu.temperature}°
            </span>
          )}
        </div>
        <span className="text-slate-600 tabular-nums">
          {resourceService.formatMemory(gpu.memoryUsed)} / {resourceService.formatMemory(gpu.memoryTotal)}
        </span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
};

export default ResourcePanel;
