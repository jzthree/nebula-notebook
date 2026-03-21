import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { CellOutput as ICellOutput, JsonValue, MimeBundle } from '../types';
import { loadExternalLibrary } from '../utils/externalLibraryLoader';
import { wrapHtmlDocument } from '../utils/htmlPreview';

const PREFERRED_MIME_TYPES = [
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

function parsePlotlyFigure(value: JsonValue | null): PlotlyFigure | null {
  if (value === null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as PlotlyFigure;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as unknown as PlotlyFigure;
  }
  return null;
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

const PlotlyOutput: React.FC<{ figure: PlotlyFigure; fallbackText?: string }> = ({ figure, fallbackText }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let activePlotly: { react?: (...args: unknown[]) => Promise<void> | void; purge?: (node: HTMLElement) => void } | null = null;

    const renderPlot = async () => {
      try {
        const plotly = await loadExternalLibrary('plotly') as {
          react?: (node: HTMLElement, data?: unknown[], layout?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<void> | void;
          purge?: (node: HTMLElement) => void;
        };

        if (cancelled || !containerRef.current || !plotly?.react) {
          return;
        }

        activePlotly = plotly;
        await plotly.react(containerRef.current, figure.data || [], figure.layout || {}, figure.config || {});
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render Plotly output');
        }
      }
    };

    setError(null);
    void renderPlot();

    return () => {
      cancelled = true;
      if (activePlotly?.purge && containerRef.current) {
        activePlotly.purge(containerRef.current);
      }
    };
  }, [figure]);

  if (error) {
    return (
      <div className="my-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <div className="font-medium">Plotly renderer failed</div>
        <div className="mt-1 whitespace-pre-wrap">{error}</div>
        {fallbackText ? <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-amber-900">{fallbackText}</pre> : null}
      </div>
    );
  }

  return <div ref={containerRef} className="my-2 min-h-[18rem] w-full overflow-x-auto rounded border border-slate-200 bg-white" />;
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
}> = memo(({ output, fallbackHtmlRenderer, fallbackImageRenderer, fallbackTextRenderer }) => {
  const preferredMimeType = pickPreferredMimeType(output.mimeBundle, output.preferredMimeType);
  const value = getBundleValue(output.mimeBundle, preferredMimeType);

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
