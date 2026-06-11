# ---
# jupyter:
#   kernelspec:
#     display_name: Python 3
#     language: python
#     name: python3
# ---

# %% [markdown] id="intro1"
# # Exoplanet survey
#
# A small analysis notebook.

# %% id="imports1"
import math

radius = 1.6
period = 385.0

# %% id="compute1"
density_proxy = radius ** 3 / period
print(f"{density_proxy:.4f}")
