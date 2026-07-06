# Using R (and other non-Python kernels)

Nebula speaks the **Jupyter protocol, not Python** — it runs any kernel registered as
a Jupyter kernelspec on the machine running the server. Python onboarding feels
smoother only because Nebula can *detect* Python environments and offer one-click
setup; other languages you install once yourself, the standard Jupyter way, and they
then appear in the kernel menu like any other.

This page covers the two things that trip people up with **R**.

## 1. Register the R kernel (one time)

R execution and rich output go through **IRkernel**. Install it in your R and register
the kernelspec:

```r
install.packages("IRkernel")   # or, for prebuilt binaries: pak::pkg_install("IRkernel")
IRkernel::installspec()        # writes ~/.local/share/jupyter/kernels/ir/
```

Nebula picks up the spec on the next kernel-menu **Refresh** (or a server restart).
There is no Nebula-side configuration — if `jupyter kernelspec list` shows it, Nebula
shows it.

## 2. Headless servers: `unable to start device PNG`

The most common R-on-a-server snag. A plot errors with something like:

```
Error in .External2(C_X11, "png::"...) : unable to start device PNG
  ... unable to open connection to X11 display ''
```

This is **not** a Nebula problem — it's R's graphics default. On many builds R sets its
bitmap (`png`) device to the **X11** backend, which needs a display that a headless
server, container, or compute node doesn't have. IRkernel opens a device for *every*
cell to capture plots, so cells fail even when they don't plot.

Fix it once, in your `~/.Rprofile`, by switching the default to **cairo** (needs no
display):

```r
# Headless-safe plotting: prefer the cairo bitmap device over X11.
if (isTRUE(capabilities("cairo"))) options(bitmapType = "cairo")
```

Restart the R kernel afterward. (`ragg`'s `agg_png` is an even higher-quality device if
you have it installed.)

**Shortcut:** Nebula recognizes this specific error and shows a hint with an **Apply
cairo fix** button right under the failed cell. Clicking it runs `options(bitmapType =
"cairo")` in the *current* kernel — then re-run your cell and the plot renders. That's
session-scoped (it doesn't touch any files); add the line to `~/.Rprofile` as above to
make it permanent.

**Why Nebula doesn't set this for you:** it's *your* R environment, and the right
default depends on the machine — a desktop with a display may prefer X11, and cairo
isn't always compiled in. Nebula's job is to run your kernel as-is, not to rewrite its
configuration behind your back. So this stays a one-line choice you own. To confirm your
build can do it: `capabilities(c("cairo", "png", "X11"))`.

## 3. If the kernel dies the instant a cell runs

On some module-provided or prebuilt R installs, a graphics package (usually **`ragg`**,
`systemfonts`, or `textshaping`) was built under a *different* R version, and IRkernel's
per-cell device crashes with a `Graphics API version mismatch`. Reinstall the graphics
stack as binaries matching your current R so they shadow the mismatched copies:

```r
install.packages(c("systemfonts", "textshaping", "ragg"))
```

---

The same principle applies to any language kernel: install it the normal Jupyter way,
keep its environment configured the way *you* want, and Nebula will run it. Nebula
detects and guides; it doesn't reconfigure your toolchain.
