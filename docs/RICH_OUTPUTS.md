# Rich Interactive Outputs

Nebula supports two rich output paths for notebook cell results:

- Jupyter-compatible MIME bundles, including Plotly's `application/vnd.plotly.v1+json`
- Nebula-native interactive outputs via `application/vnd.nebula.web+json`

The shared goal is to preserve the notebook output as structured MIME data instead of flattening everything to plain text or raw HTML.

## Current Support

Nebula currently prioritizes these MIME types when rendering `display_data` / `execute_result` outputs:

- `application/vnd.nebula.web+json`
- `application/vnd.plotly.v1+json`
- `text/html`
- `image/png`
- `text/plain`

If an output contains multiple MIME representations, Nebula picks the preferred display type and keeps the full MIME bundle available for save/reload.

## Plotly

Standard Plotly Python usage should work directly:

```python
import plotly.express as px

fig = px.line(
    x=[1, 2, 3, 4],
    y=[2, 1, 3, 5],
    title="Plotly MIME Demo",
)

fig
```

Plotly's Python library already emits `application/vnd.plotly.v1+json` in Jupyter environments. Nebula detects that MIME type and renders it with Plotly.js.

If you need the low-level form, you can also emit the MIME bundle yourself:

```python
from IPython.display import display

display(
    {
        "application/vnd.plotly.v1+json": fig.to_plotly_json(),
        "text/plain": "Plotly figure",
    },
    raw=True,
)
```

## `application/vnd.nebula.web+json`

This is a Nebula-native format for lightweight interactive outputs that are easy to generate from Python or from an LLM.

### Payload Shape

```json
{
  "version": 1,
  "html": "<div data-nebula-root></div>",
  "css": ".card { padding: 16px; }",
  "js": "container.textContent = 'hello';",
  "libraries": ["plotly"],
  "data": { "value": 42 },
  "height": 280
}
```

Supported fields:

- `version`: optional schema version
- `html`: initial HTML fragment
- `css`: CSS injected into the output shadow root
- `js`: JavaScript executed as an async function
- `libraries`: optional shared library dependencies
- `imports`: alias for `libraries`
- `data`: arbitrary JSON payload passed into the JS runtime
- `height`: initial minimum height in pixels

### Runtime Contract

Nebula executes `js` as an async function with these arguments:

- `container`: the rendered root element
- `libraries`: loaded shared libraries keyed by name
- `data`: the `data` payload
- `payload`: the full Nebula web payload

If the function returns a cleanup function, Nebula calls it when the output is unmounted.

### Python Example

```python
from IPython.display import display

payload = {
    "version": 1,
    "html": """
    <div data-nebula-root class="card">
      <h3>Interactive Counter</h3>
      <button data-inc>Increment</button>
      <strong data-value>0</strong>
    </div>
    """,
    "css": """
    .card {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 16px;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      background: white;
    }
    """,
    "data": {"value": 0},
    "js": """
    const button = container.querySelector('[data-inc]');
    const valueEl = container.querySelector('[data-value]');
    let value = data.value ?? 0;

    const render = () => {
      valueEl.textContent = String(value);
    };

    const onClick = () => {
      value += 1;
      render();
    };

    button.addEventListener('click', onClick);
    render();

    return () => button.removeEventListener('click', onClick);
    """,
}

display(
    {
        "application/vnd.nebula.web+json": payload,
        "text/plain": "Nebula interactive output",
    },
    raw=True,
)
```

## Shared Library Loading

Nebula supports page-level shared library loading so repeated outputs do not keep re-downloading the same script.

Built-in named presets currently include:

- `"plotly"`

You can also provide an explicit library spec:

```json
{
  "libraries": [
    {
      "key": "my-lib@1",
      "url": "https://example.com/my-lib.js",
      "global": "MyLib"
    }
  ]
}
```

For the built-in Plotly preset, Nebula loads Plotly.js once per page and reuses it across outputs.

## Current Limitations

Nebula does not yet implement the Jupyter widget comm protocol. That means MIME-based outputs work better than widget-based outputs right now.

Expected to work:

- standard Plotly figures
- HTML outputs
- PNG outputs
- plain rich display MIME bundles

Not supported yet:

- `ipywidgets`
- Plotly `FigureWidget`
- `ipympl`
- other libraries that depend on Jupyter comms instead of plain MIME output

## Demo Notebook

The repository includes a local demo notebook:

- [`interactive-output-demo.ipynb`](../interactive-output-demo.ipynb)

It includes:

- standard Plotly MIME output
- Nebula web output
- Nebula web output that reuses the shared Plotly runtime
- isolated HTML output
