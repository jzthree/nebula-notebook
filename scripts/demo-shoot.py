#!/usr/bin/env python3
"""
Nebula product-demo shoot — fully headless, invisible capture.

Drives a headless Chrome (DevTools Protocol) rendering the live notebook
off-screen: scrolls, injects captions, clicks, types, screenshots. Cell
execution happens in the page's own kernel (clicking run) or via the Nebula
operation API (agent scenes). PIL assembles frames into GIFs in
docs/assets/demo/. No tunnel, no Screen-Recording/Accessibility permission,
no focus stealing — runs while you use the machine.

Prereqs (see docs/DEMO-CAPTURE.md):
  - fixtures built (scripts/demo-fixtures.py), kernel libs installed
  - server up on :3000/:8000
  - headless Chrome launched with:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
        --user-data-dir=/tmp/nebula-shoot-profile \
        --window-size=1440,1000 --force-device-scale-factor=2 --hide-scrollbars \
        "http://localhost:3000/?file=/Users/jianzhou/demo/exoplanets.ipynb"

Usage:  python demo-shoot.py <scene|all>
  scenes: runall  scatter  widget  search  history  money
"""
import json, urllib.request, base64, time, os, sys, glob, shutil
import websocket
from PIL import Image

NB = "/Users/jianzhou/demo/exoplanets.ipynb"
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "assets", "demo")
OUT = os.path.abspath(OUT)
API = "http://localhost:8000"
PORT = 9222


def api_op(op):
    body = json.dumps({"operation": op}).encode()
    req = urllib.request.Request(f"{API}/api/notebook/operation", data=body,
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))


class CDP:
    def __init__(self, port=PORT):
        targets = json.load(urllib.request.urlopen(f"http://localhost:{port}/json"))
        page = next(t for t in targets if t.get("type") == "page")
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], max_size=None,
                                               header=[f"Origin: http://localhost:{port}"])
        self._id = 0
        self.cmd("Page.enable"); self.cmd("Runtime.enable")

    def cmd(self, m, p=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": m, "params": p or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self._id:
                return r.get("result", {})

    def ev(self, js):
        return self.cmd("Runtime.evaluate", {"expression": js, "returnByValue": True}).get("result", {}).get("value")

    def shot(self):
        return base64.b64decode(self.cmd("Page.captureScreenshot", {"format": "png"})["data"])

    def caption(self, text):
        self.ev('(()=>{let c=document.getElementById("demo-cap")||document.body.appendChild('
                'Object.assign(document.createElement("div"),{id:"demo-cap"}));'
                f'c.textContent={json.dumps(text)};'
                'Object.assign(c.style,{position:"fixed",left:0,right:0,bottom:0,padding:"16px 28px",'
                'font:"600 22px -apple-system,system-ui,sans-serif",color:"#fff",textAlign:"center",'
                'zIndex:2147483647,pointerEvents:"none",'
                'background:"linear-gradient(transparent,rgba(15,23,42,.85))"});return 1;})()')

    def scroll_cell(self, cid, block="center", output=False):
        target = ("c.querySelector('img')||c.querySelector('canvas')||"
                  "[...c.querySelectorAll('*')].find(e=>e.shadowRoot)||c") if output else "c"
        self.ev(f"(()=>{{const c=document.querySelector('[data-cell-id=\"{cid}\"]');"
                f"if(!c)return 0;({target}).scrollIntoView({{block:'{block}'}});return 1;}})()")

    def click_text(self, txt):
        return self.ev('(()=>{const b=[...document.querySelectorAll("button")]'
                       f'.find(b=>b.textContent.trim()==={json.dumps(txt)});'
                       'if(b){b.click();return 1;}return 0;})()')

    def click_title(self, t):
        return self.ev('(()=>{const b=[...document.querySelectorAll("button")]'
                       f'.find(b=>(b.getAttribute("title")||b.getAttribute("aria-label")||"").includes({json.dumps(t)}));'
                       'if(b){b.click();return 1;}return 0;})()')

    def click_cell_run(self, cid):
        return self.ev(f"(()=>{{const c=document.querySelector('[data-cell-id=\"{cid}\"]');"
                       "const b=[...c.querySelectorAll('button')].find(b=>/Run Cell/i.test(b.getAttribute('title')||''));"
                       "if(b){b.click();return 1;}return 0;})()")

    def type_text(self, text):
        self.cmd("Input.insertText", {"text": text})

    def key_combo(self, key, code, vk, modifiers=0):
        for ty in ("keyDown", "keyUp"):
            self.cmd("Input.dispatchKeyEvent", {"type": ty, "modifiers": modifiers,
                     "key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})


def frames_dir(name):
    d = f"/tmp/shoot-{name}"
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    return d


def assemble(name, fdir, crop=(0.05, 0.13, 0.95, 0.985), width=920, duration=180, boomerang=False, hold_last=0):
    files = sorted(glob.glob(f"{fdir}/f*.png"))
    ims = [Image.open(f).convert("RGB") for f in files]
    w, h = ims[0].size
    box = (int(w*crop[0]), int(h*crop[1]), int(w*crop[2]), int(h*crop[3]))
    out = [im.crop(box).resize((width, int((box[3]-box[1])/(box[2]-box[0])*width))) for im in ims]
    seq = out[:]
    if hold_last:
        seq += [out[-1]] * hold_last
    if boomerang:
        seq += out[::-1][1:]
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"scene-{name}.gif")
    seq[0].save(path, save_all=True, append_images=seq[1:], duration=duration, loop=0, optimize=True)
    print(f"  -> {path}  ({os.path.getsize(path)//1024} KB, {len(seq)} frames)")
    return path


# ---------------------------------------------------------------- scenes ----
def scene_runall(c):
    c.caption("Run the whole notebook — watch it come alive.")
    c.scroll_cell("title", "start")
    time.sleep(0.4)
    c.click_text("Run All")
    time.sleep(7)  # let all cells execute (tqdm ~1.7s + plot/widget)
    fd = frames_dir("runall")
    panels = ["load", "scatter", "plotly", "widget"]
    i = 0
    # hold top briefly
    for _ in range(3):
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    for cid in panels:
        c.scroll_cell(cid, "center", output=True)
        for _ in range(4):
            time.sleep(0.12)
            open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    assemble("runall", fd, duration=160)


def scene_scatter(c):
    c.caption("Run a cell — the hero plot renders instantly.")
    c.scroll_cell("scatter", "center", output=True)
    time.sleep(0.3)
    fd = frames_dir("scatter")
    i = 0
    # a couple of pre-frames, then run, then catch the render
    for _ in range(2):
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    c.click_cell_run("scatter")
    for _ in range(12):
        time.sleep(0.07)
        c.scroll_cell("scatter", "center", output=True)
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    assemble("scatter", fd, duration=120, hold_last=6)


def scene_widget(c):
    # ensure rendered
    c.click_cell_run("widget"); time.sleep(0.4)
    c.caption("Interactive outputs — click, and they respond.")
    c.scroll_cell("widget", "center", output=True)
    time.sleep(0.3)
    click = ("(()=>{const c=document.querySelector('[data-cell-id=\"widget\"]');"
             "for(const h of c.querySelectorAll('*')){if(h.shadowRoot){"
             "const b=h.shadowRoot.querySelector('[data-randomize]');if(b){b.click();return 1;}}}return 0;})()")
    fd = frames_dir("widget")
    for i in range(14):
        if i > 0:
            c.ev(click)
        time.sleep(0.16)
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot())
    assemble("widget", fd, crop=(0.05, 0.28, 0.95, 0.99), duration=200, boomerang=True)


def scene_search(c):
    c.caption("Find anything — across the whole notebook, regex included.")
    c.scroll_cell("scatter", "start")
    time.sleep(0.3)
    c.key_combo("f", "KeyF", 70, modifiers=4)  # Cmd+F opens the search bar
    time.sleep(0.6)
    fd = frames_dir("search")
    i = 0
    for _ in range(2):
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    for ch in "radius":           # type the query → live highlights + match count
        c.type_text(ch)
        time.sleep(0.2)
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    for _ in range(4):
        time.sleep(0.2)
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    c.key_combo("Escape", "Escape", 27)
    assemble("search", fd, duration=190, hold_last=6)


def scene_history(c):
    # make several distinct edits so the timeline has entries to scrub through
    api_op({"type": "endAgentSession", "notebookPath": NB, "agentId": AID})
    api_op({"type": "startAgentSession", "notebookPath": NB, "agentId": AID})
    for txt in reindent_steps(OCC_4SPACE)[::2] + [OCC_2SPACE]:
        api_op({"type": "readCell", "notebookPath": NB, "cellId": "occ", "agentId": AID})
        api_op({"type": "updateContent", "notebookPath": NB, "cellId": "occ", "agentId": AID, "content": txt})
        time.sleep(0.2)
    api_op({"type": "endAgentSession", "notebookPath": NB, "agentId": AID})
    time.sleep(0.5)

    c.caption("Scrub through your entire edit history.")
    is_open = "(()=>[...document.querySelectorAll('*')].some(e=>/^History \\(\\d+\\)/.test((e.textContent||'').trim())&&e.children.length<4))()"
    if not c.ev(is_open):
        c.click_text("History")
        time.sleep(0.8)
    fd = frames_dir("history")
    i = 0
    for _ in range(4):
        time.sleep(0.12)
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    # scrub down the timeline and back — each "Edit" entry previews a different
    # past state (diff highlight on the cell), so the capture shows real motion
    def click_edit_row(n):
        return c.ev("(()=>{const rows=[...document.querySelectorAll('div')]"
                    ".filter(e=>/\\bgroup\\b/.test(''+e.className)&&/px-2/.test(''+e.className)"
                    "&&/edit/i.test(e.textContent||'')&&(e.textContent||'').length<70);"
                    f"const r=rows[Math.min({n}, rows.length-1)]; if(r){{r.click();return rows.length;}}return 0;}})()")
    rows = 0
    for n in (1, 2, 3, 2, 1):
        rows = click_edit_row(n)
        time.sleep(0.28)
        c.scroll_cell("occ", "center")   # show the previewed cell with its diff highlight
        for _ in range(2):
            time.sleep(0.08)
            open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    print("   history edit rows:", rows)
    for _ in range(3):
        time.sleep(0.12)
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    assemble("history", fd, crop=(0.02, 0.13, 0.98, 0.985), duration=130, hold_last=6)


OCC_2SPACE = (
    "# Mandelbrot escape time — reindented live by the agent.\n"
    "def escape_time(c):\n"
    "  z = 0j\n"
    "  for n in range(100):\n"
    "    z = z * z + c\n"
    "    if abs(z) > 2.0:\n"
    "      return n\n"
    "  return 100"
)


OCC_4SPACE = (
    "# Mandelbrot escape time — the agent will reindent this 4-space block to 2.\n"
    "def escape_time(c):\n    z = 0j\n    for n in range(100):\n"
    "        z = z * z + c\n        if abs(z) > 2.0:\n            return n\n    return 100"
)
AID = "claude-code"  # one consistent agent id (end must match start to release)


def reindent_steps(src4):
    """Progressive 4->2-space reindent, halving one indented line at a time
    (top-down). Each returned string is a real cell state the agent drives the
    notebook through, so the capture shows the block visibly *tightening* live
    instead of flipping between a single before/after pair."""
    lines = src4.split("\n")
    steps = ["\n".join(lines)]
    for idx, ln in enumerate(lines):
        stripped = ln.lstrip(" ")
        indent = len(ln) - len(stripped)
        if indent >= 2 and indent % 2 == 0:
            lines[idx] = " " * (indent // 2) + stripped
            steps.append("\n".join(lines))
    return steps


def scene_agent(c):
    # one clean session for the whole scene; always pass the same agentId
    api_op({"type": "endAgentSession", "notebookPath": NB, "agentId": AID})  # clear any prior
    api_op({"type": "startAgentSession", "notebookPath": NB, "agentId": AID})
    api_op({"type": "readCell", "notebookPath": NB, "cellId": "occ", "agentId": AID})
    api_op({"type": "updateContent", "notebookPath": NB, "cellId": "occ", "agentId": AID, "content": OCC_4SPACE})
    time.sleep(0.6)

    c.caption("An agent, editing your notebook live.")
    c.scroll_cell("occ", "center")
    time.sleep(0.4)
    fd = frames_dir("agent")
    i = 0
    for _ in range(4):  # hold the 4-space "before"
        time.sleep(0.12)
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    # the agent reindents 4 -> 2 one line at a time; every step is a real OCC
    # operation, so the block visibly tightens live (purple presence ring stays on)
    for st in reindent_steps(OCC_4SPACE)[1:]:
        api_op({"type": "readCell", "notebookPath": NB, "cellId": "occ", "agentId": AID})
        api_op({"type": "updateContent", "notebookPath": NB, "cellId": "occ", "agentId": AID, "content": st})
        time.sleep(0.16)
        c.scroll_cell("occ", "center")
        for _ in range(2):
            time.sleep(0.06)
            open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    # settle on the canonical 2-space "after" (nicer comment) + hold the ring
    r = api_op({"type": "updateContent", "notebookPath": NB, "cellId": "occ", "agentId": AID, "content": OCC_2SPACE})
    print("   edit:", r.get("success"), r.get("error", ""))
    for _ in range(6):
        time.sleep(0.1)
        c.scroll_cell("occ", "center")
        open(f"{fd}/f{i:03d}.png", "wb").write(c.shot()); i += 1
    api_op({"type": "endAgentSession", "notebookPath": NB, "agentId": AID})
    assemble("agent", fd, duration=110, hold_last=6)


SCENES = {
    "runall": scene_runall, "scatter": scene_scatter, "widget": scene_widget,
    "search": scene_search, "agent": scene_agent, "history": scene_history,
}


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    c = CDP()
    names = list(SCENES) if which == "all" else [which]
    for n in names:
        print(f"[scene] {n}")
        try:
            SCENES[n](c)
        except Exception as e:
            print(f"  !! {n} failed: {e}")
        c.ev('document.getElementById("demo-cap")?.remove()')
        time.sleep(0.3)
    c.ws.close()


if __name__ == "__main__":
    main()
