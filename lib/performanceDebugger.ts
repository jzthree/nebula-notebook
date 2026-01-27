/**
 * Performance Debugger for Notebook
 *
 * Invoke via:
 * - Keyboard: Ctrl+Shift+P (when enabled)
 * - Console: window.__nebulaPerf.startProfiling() / stopProfiling() / report()
 *
 * Measures:
 * - Keystroke to render latency
 * - React render times
 * - CodeMirror update times
 * - Memory usage over time
 * - History/undo stack size
 */

export interface PerfMetrics {
  timestamp: number;
  keystrokeLatencies: number[];
  avgKeystrokeLatency: number;
  maxKeystrokeLatency: number;
  renderCount: number;
  totalRenderTime: number;
  avgRenderTime: number;
  memoryUsed?: number;
  memoryLimit?: number;
  historySize: number;
  cellCount: number;
  totalOutputSize: number;
  eventListenerCount?: number;
  codeMirrorHistorySize?: number; // Total undo entries across all CodeMirror instances
}

interface KeystrokeTiming {
  keyTime: number;
  renderTime?: number;
  latency?: number;
}

class PerformanceDebugger {
  private enabled = false;
  private profiling = false;
  private keystrokeTimings: KeystrokeTiming[] = [];
  private renderTimings: number[] = [];
  private pendingKeystroke: KeystrokeTiming | null = null;
  private metricsHistory: PerfMetrics[] = [];
  private rafId: number | null = null;

  // Callbacks to get notebook state
  private getHistorySize: (() => number) | null = null;
  private getCellCount: (() => number) | null = null;
  private getTotalOutputSize: (() => number) | null = null;

  enable() {
    if (this.enabled) return; // Already enabled, don't log again
    this.enabled = true;
    console.log('[PerfDebug] Performance debugger enabled. Use Ctrl+Shift+P to toggle profiling.');
    console.log('[PerfDebug] Or use window.__nebulaPerf.startProfiling() / stopProfiling() / report()');
  }

  disable() {
    this.enabled = false;
    this.stopProfiling();
  }

  registerCallbacks(callbacks: {
    getHistorySize?: () => number;
    getCellCount?: () => number;
    getTotalOutputSize?: () => number;
  }) {
    this.getHistorySize = callbacks.getHistorySize ?? null;
    this.getCellCount = callbacks.getCellCount ?? null;
    this.getTotalOutputSize = callbacks.getTotalOutputSize ?? null;
  }

  startProfiling() {
    if (this.profiling) {
      console.log('[PerfDebug] Already profiling');
      return;
    }

    this.profiling = true;
    this.keystrokeTimings = [];
    this.renderTimings = [];
    this.pendingKeystroke = null;

    // Add global keydown listener
    document.addEventListener('keydown', this.handleKeydown, true);

    // Patch requestAnimationFrame to measure render times
    this.patchRAF();

    console.log('[PerfDebug] 🔴 Profiling started. Type in the editor to measure latency.');
    console.log('[PerfDebug] Call window.__nebulaPerf.stopProfiling() when done.');
  }

  stopProfiling() {
    if (!this.profiling) return;

    this.profiling = false;
    document.removeEventListener('keydown', this.handleKeydown, true);
    this.unpatchRAF();

    console.log('[PerfDebug] ⏹️ Profiling stopped.');
    this.report();
  }

  toggleProfiling() {
    if (this.profiling) {
      this.stopProfiling();
    } else {
      this.startProfiling();
    }
  }

  private handleKeydown = (e: KeyboardEvent) => {
    // Ignore modifier-only keys
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    // Check for Ctrl+Shift+P to toggle profiling
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      this.toggleProfiling();
      return;
    }

    // Only measure if we're in an editor (CodeMirror)
    const target = e.target as HTMLElement;
    if (!target.closest('.cm-content')) return;

    // Record keystroke time
    this.pendingKeystroke = {
      keyTime: performance.now(),
    };
  };

  private originalRAF: typeof requestAnimationFrame | null = null;

  private patchRAF() {
    if (this.originalRAF) return;

    this.originalRAF = window.requestAnimationFrame;
    const self = this;

    window.requestAnimationFrame = function(callback: FrameRequestCallback): number {
      const wrappedCallback: FrameRequestCallback = (time) => {
        const start = performance.now();
        callback(time);
        const duration = performance.now() - start;

        // If there's a pending keystroke, this RAF likely includes the render
        if (self.pendingKeystroke && !self.pendingKeystroke.renderTime) {
          self.pendingKeystroke.renderTime = performance.now();
          self.pendingKeystroke.latency = self.pendingKeystroke.renderTime - self.pendingKeystroke.keyTime;
          self.keystrokeTimings.push(self.pendingKeystroke);

          // Log if latency is high
          if (self.pendingKeystroke.latency > 50) {
            console.log(`[PerfDebug] ⚠️ High latency: ${self.pendingKeystroke.latency.toFixed(1)}ms`);
          }

          self.pendingKeystroke = null;
        }

        if (duration > 5) {
          self.renderTimings.push(duration);
        }
      };

      return self.originalRAF!.call(window, wrappedCallback);
    };
  }

  private unpatchRAF() {
    if (this.originalRAF) {
      window.requestAnimationFrame = this.originalRAF;
      this.originalRAF = null;
    }
  }

  report(): PerfMetrics {
    const latencies = this.keystrokeTimings
      .map(t => t.latency)
      .filter((l): l is number => l !== undefined);

    const avgLatency = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

    const maxLatency = latencies.length > 0
      ? Math.max(...latencies)
      : 0;

    const avgRenderTime = this.renderTimings.length > 0
      ? this.renderTimings.reduce((a, b) => a + b, 0) / this.renderTimings.length
      : 0;

    // Get memory info if available
    const memoryInfo = (performance as any).memory;

    // Get CodeMirror internal history size
    const cmStats = this.measureCodeMirrorHistory();

    const metrics: PerfMetrics = {
      timestamp: Date.now(),
      keystrokeLatencies: latencies,
      avgKeystrokeLatency: avgLatency,
      maxKeystrokeLatency: maxLatency,
      renderCount: this.renderTimings.length,
      totalRenderTime: this.renderTimings.reduce((a, b) => a + b, 0),
      avgRenderTime,
      memoryUsed: memoryInfo?.usedJSHeapSize,
      memoryLimit: memoryInfo?.jsHeapSizeLimit,
      historySize: this.getHistorySize?.() ?? -1,
      cellCount: this.getCellCount?.() ?? -1,
      totalOutputSize: this.getTotalOutputSize?.() ?? -1,
      codeMirrorHistorySize: cmStats.totalUndoItems,
    };

    this.metricsHistory.push(metrics);

    // Print report
    console.log('\n[PerfDebug] ═══════════════════════════════════════');
    console.log('[PerfDebug] PERFORMANCE REPORT');
    console.log('[PerfDebug] ═══════════════════════════════════════');

    console.log('\n[PerfDebug] 📊 Keystroke Latency:');
    console.log(`[PerfDebug]   Samples: ${latencies.length}`);
    console.log(`[PerfDebug]   Average: ${avgLatency.toFixed(1)}ms`);
    console.log(`[PerfDebug]   Maximum: ${maxLatency.toFixed(1)}ms`);
    if (avgLatency > 100) {
      console.log(`[PerfDebug]   ⚠️ Average latency is HIGH (>100ms)`);
    } else if (avgLatency > 50) {
      console.log(`[PerfDebug]   ⚠️ Average latency is elevated (>50ms)`);
    } else {
      console.log(`[PerfDebug]   ✅ Latency is acceptable (<50ms)`);
    }

    console.log('\n[PerfDebug] 🖼️ Render Performance:');
    console.log(`[PerfDebug]   Render count: ${this.renderTimings.length}`);
    console.log(`[PerfDebug]   Avg render time: ${avgRenderTime.toFixed(1)}ms`);
    console.log(`[PerfDebug]   Total render time: ${metrics.totalRenderTime.toFixed(0)}ms`);

    if (memoryInfo) {
      const usedMB = memoryInfo.usedJSHeapSize / 1024 / 1024;
      const limitMB = memoryInfo.jsHeapSizeLimit / 1024 / 1024;
      console.log('\n[PerfDebug] 💾 Memory:');
      console.log(`[PerfDebug]   Used: ${usedMB.toFixed(1)}MB / ${limitMB.toFixed(0)}MB (${(usedMB/limitMB*100).toFixed(1)}%)`);
    }

    console.log('\n[PerfDebug] 📝 Notebook State:');
    console.log(`[PerfDebug]   Cells: ${metrics.cellCount}`);
    console.log(`[PerfDebug]   History entries: ${metrics.historySize}`);
    console.log(`[PerfDebug]   Total output size: ${(metrics.totalOutputSize / 1024).toFixed(1)}KB`);

    if (metrics.historySize > 500) {
      console.log(`[PerfDebug]   ⚠️ History is large (>${metrics.historySize} entries) - may cause slowdown`);
    }

    console.log('\n[PerfDebug] 🖊️ CodeMirror State:');
    console.log(`[PerfDebug]   Editors: ${cmStats.editorCount}`);
    console.log(`[PerfDebug]   Undo entries: ${cmStats.totalUndoItems}`);
    console.log(`[PerfDebug]   Redo entries: ${cmStats.totalRedoItems}`);
    if (cmStats.totalUndoItems > 500) {
      console.log(`[PerfDebug]   ⚠️ Large CM history - may cause lag (refresh to reset)`);
    }

    console.log('\n[PerfDebug] ═══════════════════════════════════════\n');

    return metrics;
  }

  // Get detailed breakdown when lag is detected
  diagnose() {
    console.log('\n[PerfDebug] 🔍 DIAGNOSTIC INFO');
    console.log('[PerfDebug] ═══════════════════════════════════════');

    // Check for common issues
    const issues: string[] = [];

    // 1. Check history size
    const historySize = this.getHistorySize?.() ?? 0;
    if (historySize > 1000) {
      issues.push(`Large history (${historySize} entries) - consider saving and refreshing`);
    }

    // 2. Check cell count
    const cellCount = this.getCellCount?.() ?? 0;
    if (cellCount > 100) {
      issues.push(`Many cells (${cellCount}) - virtualization should help but may still cause slowdown`);
    }

    // 3. Check output size
    const outputSize = this.getTotalOutputSize?.() ?? 0;
    if (outputSize > 5 * 1024 * 1024) {
      issues.push(`Large outputs (${(outputSize / 1024 / 1024).toFixed(1)}MB) - consider clearing old outputs`);
    }

    // 4. Check memory
    const memoryInfo = (performance as any).memory;
    if (memoryInfo) {
      const usedMB = memoryInfo.usedJSHeapSize / 1024 / 1024;
      if (usedMB > 500) {
        issues.push(`High memory usage (${usedMB.toFixed(0)}MB) - may cause GC pauses`);
      }
    }

    // 5. Check CodeMirror internal history (most likely cause of accumulated lag)
    const cmStats = this.measureCodeMirrorHistory();
    if (cmStats.totalUndoItems > 1000) {
      issues.push(`Large CodeMirror history (${cmStats.totalUndoItems} undo entries) - THIS IS LIKELY THE CAUSE. Refresh to reset.`);
    } else if (cmStats.totalUndoItems > 500) {
      issues.push(`CodeMirror history growing (${cmStats.totalUndoItems} undo entries) - may cause slowdown soon`);
    }

    if (issues.length === 0) {
      console.log('[PerfDebug] ✅ No obvious issues detected');
      console.log('[PerfDebug] Try profiling with startProfiling() to measure actual latency');
    } else {
      console.log('[PerfDebug] ⚠️ Potential issues found:');
      issues.forEach((issue, i) => {
        console.log(`[PerfDebug]   ${i + 1}. ${issue}`);
      });
    }

    console.log('\n[PerfDebug] 💡 Suggested actions:');
    console.log('[PerfDebug]   1. Save notebook and refresh page (clears accumulated state)');
    console.log('[PerfDebug]   2. Clear outputs of cells you no longer need');
    console.log('[PerfDebug]   3. Split into multiple notebooks if very large');
    console.log('[PerfDebug]   4. Use Chrome DevTools Performance tab for detailed analysis');
    console.log('[PerfDebug] ═══════════════════════════════════════\n');
  }

  // Snapshot current state for comparison
  snapshot(label: string = 'snapshot') {
    const memoryInfo = (performance as any).memory;
    const cmHistory = this.measureCodeMirrorHistory();
    const data = {
      label,
      timestamp: new Date().toISOString(),
      historySize: this.getHistorySize?.() ?? -1,
      cellCount: this.getCellCount?.() ?? -1,
      outputSize: this.getTotalOutputSize?.() ?? -1,
      memoryMB: memoryInfo ? memoryInfo.usedJSHeapSize / 1024 / 1024 : -1,
      codeMirrorHistory: cmHistory,
    };
    console.log(`[PerfDebug] 📸 Snapshot "${label}":`, data);
    return data;
  }

  /**
   * Measure CodeMirror's internal undo/redo history across all editor instances.
   * This state accumulates over time but is NOT persisted - resets on refresh.
   */
  measureCodeMirrorHistory(): { totalUndoItems: number; totalRedoItems: number; editorCount: number } {
    let totalUndoItems = 0;
    let totalRedoItems = 0;
    let editorCount = 0;

    // Find all CodeMirror editor instances in the DOM
    const editors = document.querySelectorAll('.cm-editor');

    for (const editorEl of editors) {
      // Access CodeMirror's view through the DOM element
      // The view is attached to the element by @uiw/react-codemirror
      const view = (editorEl as any).cmView?.view;
      if (!view) continue;

      editorCount++;

      try {
        // Access history state through CodeMirror's state field
        // The history extension stores its state in a StateField
        const state = view.state;
        // Try to get history field - it's not directly accessible, but we can
        // check the state fields for history-related data
        for (const field of Object.keys(state.values)) {
          const value = state.values[field];
          if (value && typeof value === 'object') {
            // History state has 'done' and 'undone' arrays
            if (Array.isArray(value.done)) {
              totalUndoItems += value.done.length;
            }
            if (Array.isArray(value.undone)) {
              totalRedoItems += value.undone.length;
            }
          }
        }
      } catch (e) {
        // Ignore errors accessing internal state
      }
    }

    return { totalUndoItems, totalRedoItems, editorCount };
  }

  /**
   * Detailed CodeMirror diagnostics
   */
  diagnoseCM() {
    console.log('\n[PerfDebug] 🔍 CODEMIRROR DIAGNOSTICS');
    console.log('[PerfDebug] ═══════════════════════════════════════');

    const cmStats = this.measureCodeMirrorHistory();

    console.log(`[PerfDebug] Editor instances: ${cmStats.editorCount}`);
    console.log(`[PerfDebug] Total undo items: ${cmStats.totalUndoItems}`);
    console.log(`[PerfDebug] Total redo items: ${cmStats.totalRedoItems}`);

    if (cmStats.totalUndoItems > 1000) {
      console.log('[PerfDebug] ⚠️ Large CodeMirror history detected!');
      console.log('[PerfDebug]    This is the most likely cause of typing lag.');
      console.log('[PerfDebug]    Each cell has its own undo history that grows unbounded.');
      console.log('[PerfDebug]    SOLUTION: Refresh the page to reset CodeMirror state.');
    } else if (cmStats.totalUndoItems > 500) {
      console.log('[PerfDebug] ⚠️ CodeMirror history is growing');
    } else {
      console.log('[PerfDebug] ✅ CodeMirror history size is normal');
    }

    console.log('[PerfDebug] ═══════════════════════════════════════\n');

    return cmStats;
  }
}

// Create singleton instance
export const perfDebugger = new PerformanceDebugger();

// Expose to window for console access
if (typeof window !== 'undefined') {
  (window as any).__nebulaPerf = {
    enable: () => perfDebugger.enable(),
    disable: () => perfDebugger.disable(),
    startProfiling: () => perfDebugger.startProfiling(),
    stopProfiling: () => perfDebugger.stopProfiling(),
    toggle: () => perfDebugger.toggleProfiling(),
    report: () => perfDebugger.report(),
    diagnose: () => perfDebugger.diagnose(),
    diagnoseCM: () => perfDebugger.diagnoseCM(),
    snapshot: (label?: string) => perfDebugger.snapshot(label),
    measureCMHistory: () => perfDebugger.measureCodeMirrorHistory(),
  };
}
