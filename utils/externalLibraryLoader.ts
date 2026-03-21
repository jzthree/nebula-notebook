type ScriptLibrarySpec = {
  key: string;
  url: string;
  globalName: string;
};

type NamedLibrarySpec =
  | string
  | {
      name?: string;
      key?: string;
      url?: string;
      global?: string;
      version?: string;
    };

const DEFAULT_PLOTLY_VERSION = '2.35.2';
const scriptLoadCache = new Map<string, Promise<unknown>>();

function getKnownLibrarySpec(spec: NamedLibrarySpec): ScriptLibrarySpec {
  if (typeof spec === 'string') {
    if (spec === 'plotly') {
      return {
        key: `plotly@${DEFAULT_PLOTLY_VERSION}`,
        url: `https://cdn.plot.ly/plotly-${DEFAULT_PLOTLY_VERSION}.min.js`,
        globalName: 'Plotly',
      };
    }

    throw new Error(`Unknown library "${spec}"`);
  }

  if (spec.name === 'plotly') {
    const version = spec.version || DEFAULT_PLOTLY_VERSION;
    return {
      key: spec.key || `plotly@${version}`,
      url: spec.url || `https://cdn.plot.ly/plotly-${version}.min.js`,
      globalName: spec.global || 'Plotly',
    };
  }

  if (!spec.url || !spec.global) {
    throw new Error('Custom libraries must include both "url" and "global"');
  }

  return {
    key: spec.key || spec.url,
    url: spec.url,
    globalName: spec.global,
  };
}

export async function loadExternalLibrary(spec: NamedLibrarySpec): Promise<unknown> {
  const resolved = getKnownLibrarySpec(spec);

  if (scriptLoadCache.has(resolved.key)) {
    return scriptLoadCache.get(resolved.key)!;
  }

  const existingGlobal = (window as typeof window & Record<string, unknown>)[resolved.globalName];
  if (existingGlobal) {
    const ready = Promise.resolve(existingGlobal);
    scriptLoadCache.set(resolved.key, ready);
    return ready;
  }

  const loadPromise = new Promise<unknown>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[data-nebula-lib-key="${resolved.key}"]`);
    if (existingScript) {
      existingScript.addEventListener('load', () => {
        resolve((window as typeof window & Record<string, unknown>)[resolved.globalName]);
      }, { once: true });
      existingScript.addEventListener('error', () => {
        reject(new Error(`Failed to load ${resolved.key}`));
      }, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = resolved.url;
    script.async = true;
    script.dataset.nebulaLibKey = resolved.key;
    script.onload = () => {
      resolve((window as typeof window & Record<string, unknown>)[resolved.globalName]);
    };
    script.onerror = () => {
      scriptLoadCache.delete(resolved.key);
      reject(new Error(`Failed to load ${resolved.key}`));
    };
    document.head.appendChild(script);
  });

  scriptLoadCache.set(resolved.key, loadPromise);
  return loadPromise;
}
