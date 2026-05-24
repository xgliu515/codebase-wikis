# DwarfStar 4 Wiki (unofficial study notes)

> **Analyzed version**: [`antirez/ds4@f91c12b`](https://github.com/antirez/ds4/tree/f91c12b) (main, 2026-05-24). All `file:line` references and jump links are locked to this commit — the code you see when clicking is exactly the code this wiki was written against.
>
> **Disclaimer**: This repo is personal study notes from reading [DwarfStar 4 (ds4)](https://github.com/antirez/ds4) source code. **No affiliation with antirez or the upstream project**, not endorsed by them. All interpretations are mine and may be wrong — source code is authoritative.
>
> **AI assistance**: Chapter prose and visualizations were drafted with Claude (Anthropic), then reviewed and iterated by the author. This is a mono-repo — wikis live under `<project>/<version>/`, with older versions retained for browsing. See "Projects / Versions" below.

---

A wiki **for anyone seriously reading DwarfStar 4 source for the first time**:

- **15 reference chapters** covering subsystems comprehensively
- **17-step trace tour**: narrative-style — problem → naive solution → why it fails → actual design — following one minimum-viable real request (`./ds4 -m DS4.gguf -p "hello" -n 3`) through the entire stack
- **SVG figures**: hand-crafted, theme-aware, scale cleanly
- **Interactive web viewer**: term popups, full-text search, keyboard navigation, clickable architecture diagram, `file:line` deep-links to GitHub

## How to read

1. Open `https://xgliu515.github.io/codebase-wikis/dwarfstar-4/` (or run the local viewer below).
2. First visit: read the **trace tour** end-to-end (~1-2 hours). Builds the mental model.
3. Second pass: use the **reference chapters** for depth on subsystems that interested you.
4. Hover any underlined term for a popup definition; click `file:line` codes to jump to GitHub.

## Run locally

```bash
git clone https://github.com/xgliu515/codebase-wikis.git
cd codebase-wikis
python3 -m http.server 8765
# open http://localhost:8765/dwarfstar-4/
```

## Chapter map

(populated by the skill — see the live viewer for the canonical list)

## Viewer features

- **3-column layout**: chapter nav (left) / content (middle) / page TOC with scrollspy (right)
- **Term highlight + popup**: terms in body text get a dashed underline; click opens the right-side panel with the definition. Definitions can link to other terms — popup recursively expands.
- **Full-text search**: press `/` to focus; results show chapter + snippet + match highlight.
- **Keyboard shortcuts**: `j` / `k` next / previous, `t` toggle theme, `g h` home, `Esc` close popup.
- **Source link mode**: by default `file:line` codes jump to GitHub at the locked commit. Click the **Source** topbar button to switch to local VSCode (requires VSCode installed and the project cloned locally).
- **Mermaid + KaTeX**: diagrams and math render inline; click a mermaid block to expand.

## Projects / Versions

This wiki lives in a mono-repo — see [`codebase-wikis`](https://github.com/xgliu515/codebase-wikis) for the top-level project selector. The DwarfStar 4 project has multiple snapshots over time; use the version switcher in the topbar. Note: earlier snapshots may be in Chinese; this snapshot (`f91c12b`) is the first English edition.

## Contributing

- Found a bug or unclear passage → open an issue, please cite `file:line`
- Want to add a chapter or diagram → PR welcome, but open an issue first to coordinate

## License

MIT. The wiki content is the author's analysis of upstream DwarfStar 4 source code; you're free to re-use under MIT terms. Upstream DwarfStar 4 retains its own license.
