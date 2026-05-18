# Codebase Wikis

多个开源项目的中文学习 wiki 合集（mono-repo）。三级结构 `仓库 / 项目 / 版本 / wiki`：每个项目一个目录，目录下按分析的代码版本再分子目录，每个版本是一份完整、自包含的 wiki。

## 在线浏览

**<https://xgliu515.github.io/codebase-wikis/>**

打开是项目选择页 → 选项目 → 选版本 → 进入 wiki。查看器顶栏有项目下拉和版本下拉，可随时切换。

## 本地浏览

```bash
git clone https://github.com/xgliu515/codebase-wikis.git
cd codebase-wikis
python3 -m http.server 8765
# 浏览器打开 http://localhost:8765/
```

## 当前收录

| 项目 | 上游 | 分析版本 |
|------|------|----------|
| DwarfStar 4 | [antirez/ds4](https://github.com/antirez/ds4) | `c9dd949` |
| llama.cpp | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | `b9209` |

## 说明

每份 wiki 的章节正文与可视化由 Claude（Anthropic）协助生成，作者审阅并迭代修订。所有 `file:line` 引用、跳转链接锁定在各自分析时的上游 commit。本仓库与各上游官方无任何关联，未获其背书，准确性以源码为准。

## License

[MIT](LICENSE)。各 wiki 引用的源码片段、`file:line` 标注归各上游项目及其贡献者所有。

---

*用 [codebase-wiki](https://github.com/xgliu515/codebase-wiki) skill 生成。*
