# OpenClaw Wiki (unofficial study notes)

> **Analyzed version**: [`openclaw/openclaw@a374c3a5bf`](https://github.com/openclaw/openclaw/tree/a374c3a5bf) (v2026.5.22, 2026-05-24). All `file:line` references and jump links are locked to this commit — the code you see when clicking is exactly the code this wiki was written against.
>
> **Disclaimer**: This repo is personal study notes from reading [OpenClaw](https://github.com/openclaw/openclaw) source code. **No affiliation with the official openclaw team**, not endorsed by them. All interpretations are mine and may be wrong — source code is authoritative.
>
> **AI assistance**: Chapter prose and visualizations were drafted with Claude (Anthropic), then reviewed and iterated by the author. This is a mono-repo — wikis live under `<project>/<version>/`, with older versions retained for browsing. See "Projects / Versions" below.

---

A wiki **for anyone seriously reading OpenClaw source for the first time**:

- **15 reference chapters** covering subsystems comprehensively
- **18-step trace tour**: narrative-style — problem → naive solution → why it fails → actual design — following one WebChat "hello" round-trip through the entire stack
- **SVG figures**: hand-crafted, theme-aware, scale cleanly
- **Interactive web viewer**: term popups, full-text search, keyboard navigation, clickable architecture diagram, `file:line` deep-links to GitHub

## How to read

1. Open `https://xgliu515.github.io/codebase-wikis/openclaw/` (or run the local viewer below).
2. First visit: read the **trace tour** end-to-end (~1-2 hours). Builds the mental model.
3. Second pass: use the **reference chapters** for depth on subsystems that interested you.
4. Hover any underlined term for a popup definition; click `file:line` codes to jump to GitHub.

## Run locally

```bash
git clone https://github.com/xgliu515/codebase-wikis.git
cd codebase-wikis
python3 -m http.server 8765
# open http://localhost:8765/openclaw/
```

## Chapter map

See the live viewer — `web/js/chapters.js` is the canonical list.

## Viewer features

- **3-column layout**: chapter nav (left) / content (middle) / page TOC with scrollspy (right)
- **Term highlight + popup**: terms in body text get a dashed underline; click opens the right-side panel with the definition. Definitions can link to other terms — popup recursively expands.
- **Full-text search**: press `/` to focus; results show chapter + snippet + match highlight.
- **Keyboard shortcuts**: `j` / `k` next / previous, `t` toggle theme, `g h` home, `Esc` close popup.
- **Source link mode**: by default `file:line` codes jump to GitHub at the locked commit. Click the **Source** topbar button to switch to local VSCode (requires VSCode installed and the project cloned locally).
- **Mermaid + KaTeX**: diagrams and math render inline; click a mermaid block to expand.

## Projects / Versions

This wiki lives in a mono-repo — see [`codebase-wikis`](https://github.com/xgliu515/codebase-wikis) for the top-level project selector. Each project may have multiple snapshots over time; use the version switcher in the topbar.

## Contributing

- Found a bug or unclear passage → open an issue, please cite `file:line`
- Want to add a chapter or diagram → PR welcome, but open an issue first to coordinate

## License

MIT. The wiki content is the author's analysis of upstream OpenClaw source code; you're free to re-use under MIT terms. Upstream OpenClaw retains its own license.
