#!/usr/bin/env python3
"""Inline the shared stylesheet, icon set and decision core into each front-end,
so every product stays a single portable file."""
import pathlib

src = pathlib.Path("src")
ui    = (src/"ui.css").read_text()
ds    = (src/"ds.css").read_text()
icons = (src/"icons.js").read_text()
art   = (src/"art.js").read_text()
core  = (src/"core.js").read_text()

TARGETS = [("index.html", "index.html", ui, icons + "\n" + art + "\n" + core),
           ("web.html", "web.html", ui, icons + "\n" + art + "\n" + core),
           ("app.html", "app.html", ui, icons + "\n" + art + "\n" + core),
           ("reviewer.html", "reviewer-console.html", ds, core)]

for name, out, css, js in TARGETS:
    h = (src/name).read_text().replace("__UI__", css).replace("__DS__", css).replace("__CORE__", js)
    for token in ("__UI__", "__DS__", "__CORE__"):
        assert token not in h, f"{token} left in {name}"
    pathlib.Path(out).write_text(h)
    print(f"{out:26} {len(h)//1024:>3} KB")

tpl = pathlib.Path("tower_template.html").read_text()
data = pathlib.Path("control_tower_data.json").read_text()
pathlib.Path("control-tower.html").write_text(tpl.replace("__SNAPSHOT_JSON__", data))
print(f"{'control-tower.html':26} rebuilt from the engine export")
