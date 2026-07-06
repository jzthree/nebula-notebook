import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CellOutput as ICellOutput, JsonValue, MimeBundle } from '../types';
import { loadExternalLibrary } from '../utils/externalLibraryLoader';
import { wrapHtmlDocument } from '../utils/htmlPreview';
import { getWidgetManager, WidgetViewHandle } from '../services/widgetManager';

const WIDGET_VIEW_MIME = 'application/vnd.jupyter.widget-view+json';

const PREFERRED_MIME_TYPES = [
  WIDGET_VIEW_MIME,
  'application/vnd.nebula.web+json',
  'application/vnd.plotly.v1+json',
  'text/html',
  'image/png',
  'text/plain',
] as const;

type NebulaLibrarySpec =
  | string
  | {
      name?: string;
      key?: string;
      url?: string;
      global?: string;
      version?: string;
    };

type NebulaWebPayload = {
  version?: number;
  html?: string;
  css?: string;
  js?: string;
  libraries?: NebulaLibrarySpec[];
  imports?: NebulaLibrarySpec[];
  data?: JsonValue;
  height?: number;
};

type PlotlyFigure = {
  data?: unknown[];
  layout?: Record<string, unknown>;
  config?: Record<string, unknown>;
  frames?: unknown[];
};

const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function pickPreferredMimeType(bundle: MimeBundle | undefined, preferredMimeType?: string): string | null {
  if (!bundle) return preferredMimeType ?? null;
  if (preferredMimeType && preferredMimeType in bundle) {
    return preferredMimeType;
  }

  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (mimeType in bundle) return mimeType;
  }

  const [firstMimeType] = Object.keys(bundle);
  return firstMimeType ?? preferredMimeType ?? null;
}

function getBundleValue(bundle: MimeBundle | undefined, mimeType: string | null): JsonValue | null {
  if (!bundle || !mimeType) return null;
  return bundle[mimeType] ?? null;
}

function stringifyValue(value: JsonValue | null): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/**
 * Decode a Plotly binary typed-array object ({dtype, bdata}) to a plain JS array.
 * Newer plotly.py encodes numeric arrays this way for efficiency.
 */
function decodePlotlyBinaryArray(obj: { dtype: string; bdata: string }): number[] {
  const b64 = obj.bdata;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dtypeMap: Record<string, { ctor: new (buf: ArrayBuffer) => { length: number; [i: number]: number }; size: number }> = {
    i1: { ctor: Int8Array, size: 1 },
    u1: { ctor: Uint8Array, size: 1 },
    i2: { ctor: Int16Array, size: 2 },
    u2: { ctor: Uint16Array, size: 2 },
    i4: { ctor: Int32Array, size: 4 },
    u4: { ctor: Uint32Array, size: 4 },
    f4: { ctor: Float32Array, size: 4 },
    f8: { ctor: Float64Array, size: 8 },
  };
  const spec = dtypeMap[obj.dtype];
  if (!spec) return Array.from(bytes);
  const typed = new spec.ctor(bytes.buffer);
  return Array.from(typed as unknown as ArrayLike<number>);
}

function isPlotlyBinaryArray(v: unknown): v is { dtype: string; bdata: string } {
  return typeof v === 'object' && v !== null && 'dtype' in v && 'bdata' in v;
}

/**
 * Walk a Plotly trace/layout object and decode any binary-encoded arrays in place.
 */
function decodeBinaryArrays(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (isPlotlyBinaryArray(val)) {
      obj[key] = decodePlotlyBinaryArray(val);
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      decodeBinaryArrays(val as Record<string, unknown>);
    }
  }
}

function parsePlotlyFigure(value: JsonValue | null): PlotlyFigure | null {
  if (value === null) return null;
  let fig: PlotlyFigure | null = null;
  if (typeof value === 'string') {
    try {
      fig = JSON.parse(value) as PlotlyFigure;
    } catch {
      return null;
    }
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    fig = value as unknown as PlotlyFigure;
  }
  if (!fig) return null;

  // Newer plotly.py encodes numeric arrays as {dtype, bdata} binary objects.
  // Decode them to plain arrays for Plotly.js compatibility.
  if (fig.data) {
    for (const trace of fig.data) {
      decodeBinaryArrays(trace as Record<string, unknown>);
    }
  }

  // Also decode binary arrays in layout (e.g., axis tickvals, range, shapes)
  if (fig.layout && typeof fig.layout === 'object') {
    decodeBinaryArrays(fig.layout as unknown as Record<string, unknown>);
  }

  return fig;
}

function parseNebulaWebPayload(value: JsonValue | null): NebulaWebPayload | null {
  if (value === null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as NebulaWebPayload;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as unknown as NebulaWebPayload;
  }
  return null;
}

function isIsolatedHtml(metadata: ICellOutput['metadata'] | undefined): boolean {
  const htmlMetadata = metadata?.['text/html'];
  return Boolean(
    htmlMetadata &&
      typeof htmlMetadata === 'object' &&
      !Array.isArray(htmlMetadata) &&
      (htmlMetadata as Record<string, JsonValue>).isolated === true,
  );
}

type PlotlyLib = {
  react?: (node: HTMLElement, data?: unknown[], layout?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<void> | void;
  purge?: (node: HTMLElement) => void;
};

function usePlotlyRender(
  containerRef: React.RefObject<HTMLDivElement | null>,
  figure: PlotlyFigure,
  layoutOverrides?: Record<string, unknown>,
  onError?: (msg: string) => void,
) {
  useEffect(() => {
    let cancelled = false;
    let activePlotly: PlotlyLib | null = null;

    const renderPlot = async () => {
      try {
        const plotly = (await loadExternalLibrary('plotly')) as PlotlyLib;

        if (cancelled || !containerRef.current || !plotly?.react) {
          return;
        }

        activePlotly = plotly;
        const layout = layoutOverrides
          ? { ...figure.layout, ...layoutOverrides }
          : figure.layout || {};
        await plotly.react(containerRef.current, figure.data || [], layout, figure.config || {});
      } catch (err) {
        if (!cancelled && onError) {
          onError(err instanceof Error ? err.message : 'Failed to render Plotly output');
        }
      }
    };

    void renderPlot();

    return () => {
      cancelled = true;
      if (activePlotly?.purge && containerRef.current) {
        activePlotly.purge(containerRef.current);
      }
    };
  }, [containerRef, figure, layoutOverrides, onError]);
}

const PlotlyModalViewer: React.FC<{ figure: PlotlyFigure; onClose: () => void }> = ({ figure, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const layoutOverrides = useMemo(
    () => ({ autosize: true, paper_bgcolor: 'white', plot_bgcolor: undefined }),
    [],
  );

  const handleError = useCallback((msg: string) => {
    console.error('[PlotlyModal]', msg);
  }, []);

  usePlotlyRender(containerRef, figure, layoutOverrides, handleError);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex flex-col" onClick={onClose}>
      <div className="flex justify-end p-3 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full bg-slate-900/70 px-3 py-1.5 text-sm text-white/85 hover:text-white hover:bg-slate-900 z-20"
        >
          Close
        </button>
      </div>
      <div
        className="flex-1 min-h-0 p-4 overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div ref={containerRef} className="w-full min-h-full bg-white rounded-lg" />
      </div>
    </div>,
    document.body,
  );
};

const PlotlyOutput: React.FC<{ figure: PlotlyFigure; fallbackText?: string }> = ({ figure, fallbackText }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleError = useCallback((msg: string) => setError(msg), []);

  usePlotlyRender(containerRef, figure, undefined, handleError);

  if (error) {
    return (
      <div className="my-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <div className="font-medium">Plotly renderer failed</div>
        <div className="mt-1 whitespace-pre-wrap">{error}</div>
        {fallbackText ? <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-amber-900">{fallbackText}</pre> : null}
      </div>
    );
  }

  return (
    <>
      {isFullscreen && <PlotlyModalViewer figure={figure} onClose={() => setIsFullscreen(false)} />}
      <div className="my-2 relative group overflow-hidden rounded border border-slate-200">
        <button
          type="button"
          onClick={() => setIsFullscreen(true)}
          className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity rounded bg-slate-800/70 px-2 py-1 text-xs text-white hover:bg-slate-800"
          title="View fullscreen"
        >
          Expand
        </button>
        <div ref={containerRef} className="min-h-[18rem] w-full overflow-x-auto bg-white" />
      </div>
    </>
  );
};

const NebulaWebOutput: React.FC<{ payload: NebulaWebPayload; fallbackText?: string }> = ({ payload, fallbackText }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanupFn: (() => void) | undefined;

    const mount = async () => {
      if (!hostRef.current) return;

      const shadowRoot = hostRef.current.shadowRoot || hostRef.current.attachShadow({ mode: 'open' });
      const frame = document.createElement('div');
      frame.style.minHeight = `${payload.height ?? 240}px`;
      frame.innerHTML = payload.html || '<div data-nebula-root></div>';

      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; display: block; }
        .nebula-web-root { box-sizing: border-box; }
        ${payload.css || ''}
      `;

      shadowRoot.replaceChildren(style, frame);
      const root = frame.querySelector<HTMLElement>('[data-nebula-root]') || frame;

      try {
        const libraries = payload.libraries || payload.imports || [];
        const loadedLibraries: Record<string, unknown> = {};
        for (const library of libraries) {
          const libraryName = typeof library === 'string'
            ? library
            : library.name || library.key || library.global || library.url || `lib-${Object.keys(loadedLibraries).length}`;
          loadedLibraries[libraryName] = await loadExternalLibrary(library);
        }

        if (!payload.js) return;

        const runner = new AsyncFunction('container', 'libraries', 'data', 'payload', payload.js);
        const maybeCleanup = await runner(root, loadedLibraries, payload.data ?? null, payload);
        if (typeof maybeCleanup === 'function') {
          cleanupFn = maybeCleanup as () => void;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render interactive output');
        }
      }
    };

    setError(null);
    void mount();

    return () => {
      cancelled = true;
      cleanupFn?.();
    };
  }, [payload]);

  if (error) {
    return (
      <div className="my-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <div className="font-medium">Interactive renderer failed</div>
        <div className="mt-1 whitespace-pre-wrap">{error}</div>
        {fallbackText ? <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-amber-900">{fallbackText}</pre> : null}
      </div>
    );
  }

  return <div ref={hostRef} className="my-2 w-full overflow-hidden rounded border border-slate-200 bg-white shadow-sm" />;
};

type WidgetViewPayload = {
  model_id?: string;
  version_major?: number;
  version_minor?: number;
};

function parseWidgetViewPayload(value: JsonValue | null): WidgetViewPayload | null {
  if (value === null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as WidgetViewPayload;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as unknown as WidgetViewPayload;
  }
  return null;
}

/**
 * Live ipywidgets view. Widget MODEL state lives in the per-session widget
 * manager (services/widgetManager.ts); this component only creates a VIEW on
 * mount and destroys it on unmount, so virtualized scroll-away/back re-renders
 * the same live model.
 */
const WidgetViewOutput: React.FC<{
  modelId: string;
  sessionId: string;
  fallbackText: string;
  fallbackTextRenderer: (text: string) => React.ReactNode;
}> = ({ modelId, sessionId, fallbackText, fallbackTextRenderer }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'live' | 'stale' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let viewHandle: WidgetViewHandle | null = null;

    setState('loading');
    setError(null);

    const mount = async () => {
      try {
        const manager = await getWidgetManager(sessionId);
        if (cancelled || !hostRef.current) return;
        viewHandle = await manager.renderModel(modelId, hostRef.current);
        if (cancelled) {
          viewHandle?.dispose();
          viewHandle = null;
          return;
        }
        setState(viewHandle ? 'live' : 'stale');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render widget');
          setState('error');
        }
      }
    };

    void mount();

    return () => {
      cancelled = true;
      // Destroy the view but NOT the model — the manager keeps model state so
      // the widget stays live when this cell scrolls back into view.
      viewHandle?.dispose();
      viewHandle = null;
    };
  }, [modelId, sessionId]);

  if (state === 'stale') {
    return (
      <div className="my-2 rounded border border-slate-200 bg-slate-50 px-3 py-2">
        <div className="text-xs text-slate-500">Widget no longer live — re-run the cell to reconnect it.</div>
        {fallbackText ? (
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-slate-400">{fallbackText}</pre>
        ) : null}
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="my-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <div className="font-medium">Widget renderer failed</div>
        {error ? <div className="mt-1 whitespace-pre-wrap">{error}</div> : null}
        {fallbackText ? <div className="mt-2 text-xs text-amber-900">{fallbackTextRenderer(fallbackText)}</div> : null}
      </div>
    );
  }

  return <div ref={hostRef} className="my-2 w-full overflow-x-auto" />;
};

const IsolatedHtmlOutput: React.FC<{ html: string }> = ({ html }) => {
  const srcDoc = useMemo(() => wrapHtmlDocument(html), [html]);

  return (
    <div className="my-2 overflow-hidden rounded border border-slate-200 bg-white">
      <iframe
        title="Isolated HTML Output"
        className="h-[24rem] w-full border-0"
        sandbox="allow-scripts allow-popups allow-downloads"
        srcDoc={srcDoc}
      />
    </div>
  );
};

const HtmlOutputRenderer: React.FC<{ html: string; isolated: boolean }> = ({ html, isolated }) => {
  if (isolated) {
    return <IsolatedHtmlOutput html={html} />;
  }

  return <div dangerouslySetInnerHTML={{ __html: html }} className="overflow-x-auto" />;
};

export const DisplayDataOutput: React.FC<{
  output: ICellOutput;
  fallbackHtmlRenderer: (html: string, isolated: boolean) => React.ReactNode;
  fallbackImageRenderer: (base64: string) => React.ReactNode;
  fallbackTextRenderer: (text: string) => React.ReactNode;
  kernelSessionId?: string; // Live kernel session for interactive widget outputs
}> = memo(({ output, fallbackHtmlRenderer, fallbackImageRenderer, fallbackTextRenderer, kernelSessionId }) => {
  const preferredMimeType = pickPreferredMimeType(output.mimeBundle, output.preferredMimeType);
  const value = getBundleValue(output.mimeBundle, preferredMimeType);

  if (preferredMimeType === WIDGET_VIEW_MIME) {
    const payload = parseWidgetViewPayload(value);
    const plainText = stringifyValue(getBundleValue(output.mimeBundle, 'text/plain')) || output.content || '';
    if (payload?.model_id && kernelSessionId) {
      return (
        <WidgetViewOutput
          modelId={payload.model_id}
          sessionId={kernelSessionId}
          fallbackText={plainText}
          fallbackTextRenderer={fallbackTextRenderer}
        />
      );
    }
    // No live kernel session (loaded notebook, kernel off) or malformed
    // payload: fall back to the text/plain repr from the mime bundle.
    return <>{fallbackTextRenderer(plainText)}</>;
  }

  if (preferredMimeType === 'application/vnd.plotly.v1+json') {
    const figure = parsePlotlyFigure(value);
    if (figure) {
      return <PlotlyOutput figure={figure} fallbackText={output.content} />;
    }
  }

  if (preferredMimeType === 'application/vnd.nebula.web+json') {
    const payload = parseNebulaWebPayload(value);
    if (payload) {
      return <NebulaWebOutput payload={payload} fallbackText={output.content} />;
    }
  }

  if (preferredMimeType === 'text/html') {
    return <>{fallbackHtmlRenderer(stringifyValue(value), isIsolatedHtml(output.metadata))}</>;
  }

  if (preferredMimeType === 'image/png') {
    return <>{fallbackImageRenderer(stringifyValue(value))}</>;
  }

  return <>{fallbackTextRenderer(output.content || stringifyValue(value))}</>;
});

DisplayDataOutput.displayName = 'DisplayDataOutput';
HtmlOutputRenderer.displayName = 'HtmlOutputRenderer';

export { HtmlOutputRenderer };
