// templates/web/js/strings.js
// Bilingual UI string table. Runtime picks language from <html lang>.
// Per-project content (chapter titles, layer names) lives in chapters.js / architecture.js, NOT here.

export const STRINGS = {
  zh: {
    // <title> suffix — also embedded at scaffold time via {{TITLE_SUFFIX}} in index.html
    title_suffix: '中文参考 Wiki',

    // Topbar
    search_placeholder: '搜索 (按 / 聚焦)',
    switch_project: '切换项目',
    switch_version: '切换版本',
    prev_chapter: '上一章 (k)',
    next_chapter: '下一章 (j)',
    toggle_theme: '切换主题 (t)',
    source_mode_btn_label: '源码',
    source_mode_title: '源码链接模式(默认 GitHub,可切到本地 VSCode)',

    // Loading / empty states
    loading: '加载中…',
    loading_chapter: (title) => `加载 ${title}…`,
    rendering: '⏳ 渲染中…',
    toc_title: '本页目录',
    toc_empty: '无目录',
    search_no_results: '无结果',
    click_to_expand: '点击放大',

    // Sidebar
    sidebar_home: '首页',
    sidebar_tour_head: '单请求 Trace 导览',
    sidebar_ref_head: (n) => `参考手册(${n} 章)`,
    sidebar_toggle_aria: '展开/收起',

    // Toasts / navigation
    toast_first: '已经是第一篇',
    toast_last: '已经是最后一篇',

    // Source-mode dialog (app.js repo-root-btn)
    source_mode_local: '本地 VSCode',
    source_mode_prompt: (mode, project) =>
      `当前模式:${mode}\n\n` +
      `留空(默认)→ 跳到 GitHub 上对应 commit、对应行号\n` +
      `输入本地 ${project} 仓库绝对路径 → 跳到本地 VSCode(需先装好 VSCode)\n\n` +
      `路径示例:/Users/你的名字/git/<仓库目录>`,
    source_mode_switched_local: '已切到本地 VSCode 模式。刷新生效',
    source_mode_switched_github: '已切到 GitHub 模式。刷新生效',

    // file-ref verb (content.js enhanceFileRefs)
    file_ref_verb_local: '在 VSCode 中打开',
    file_ref_verb_github: '在 GitHub 打开',

    // Error / not-found pages (content.js loadChapter)
    err_chapter_not_found_h1: '章节未找到',
    err_chapter_not_found_body: (id) => `未知章节 ID: <code>${id}</code>`,
    err_back_home: '回到首页',
    err_load_failed_h1: '加载失败',
    err_startup_failed_h1: '启动失败',

    // Home page (content.js renderHome)
    home_stats_summary: (steps, chapters) => `<strong>${steps}</strong> 步导览 + <strong>${chapters}</strong> 章参考`,
    home_stats_analyzed: '分析版本:',
    home_stats_focus: '聚焦:',
    home_trace_h2: (project) => `推荐第一遍这样学:跟一次最简请求穿过 ${project} 全栈`,
    home_trace_lede: (steps, project, traceTarget) =>
      `${steps} 步导览,按 <strong>问题 → 朴素思路为何崩 → ${project} 怎么解决</strong> 的逻辑链展开。` +
      `围绕 <code>${traceTarget}</code> 一个具体请求,逐层走完整个 ${project}。`,
    home_trace_cta: '→ 进入导览(建议第一次学先读这个)',
    home_trace_sample: '或直接看第 1 步样品',
    home_arch_h2: '架构总览',
    home_arch_play: '▶ 播放一次请求流',
    home_arch_reset: '重置',
    home_arch_caption: '点击任一层跳转到对应章节;点击"播放"看一次请求穿过四层。',
    home_tour_h2: (steps) => `单请求 Trace 导览(${steps} 步)`,
    home_tour_lede: (project) =>
      `每步约 150 行,按 8 段模板:当前情境 → 问题 → 朴素思路 → 为何崩 → ${project} 做法 → 代码位置 → 分支链接 → 学到了什么。`,
    home_ref_h2: (chapters) => `参考手册(${chapters} 章)`,
    home_ref_lede: '完整的子系统参考,作为导览的深度补充。每章独立,可随时跳转。',
    home_kbd_h2: '键盘快捷键',
    home_kbd_search: '聚焦搜索框',
    home_kbd_next_prev: '下一章 / 上一章',
    home_kbd_theme: '切换深色/浅色主题',
    home_kbd_home: '回首页',
    home_kbd_close: '关闭弹窗 / 搜索结果',

    // Addendum banner (content.js makeAddendumBanner)
    addendum_banner_q_prefix: '本节回答:',
    addendum_banner_back: (parent) => `↑ 回到 ${parent}`,

    // Glossary panel (glossary.js)
    gloss_back_btn: '‹ 返回',
    gloss_back_title: '返回上一个 (←)',
    gloss_close_title: '关闭 (Esc)',
    gloss_reset_btn: '重置',
    gloss_reset_title: '清除本地"已查看"记录',
    gloss_no_definition: '*(无定义)*',
    gloss_english_label: '英文原名',
    gloss_chinese_label: '中文译名',
    gloss_source_label: '代码位置',
    gloss_hover_tooltip: (termKey) => `点击查看「${termKey}」的解释`,
    gloss_open_file: (path) => `打开 ${path}`,
    gloss_viewed_count: (viewed, total) => `已查看 ${viewed} / ${total} 条术语`,
  },

  en: {
    title_suffix: 'Wiki',

    search_placeholder: 'Search (press /)',
    switch_project: 'Switch project',
    switch_version: 'Switch version',
    prev_chapter: 'Previous (k)',
    next_chapter: 'Next (j)',
    toggle_theme: 'Toggle theme (t)',
    source_mode_btn_label: 'Source',
    source_mode_title: 'Source link mode (default GitHub, can switch to local VSCode)',

    loading: 'Loading…',
    loading_chapter: (title) => `Loading ${title}…`,
    rendering: '⏳ Rendering…',
    toc_title: 'On this page',
    toc_empty: 'No outline',
    search_no_results: 'No results',
    click_to_expand: 'Click to expand',

    sidebar_home: 'Home',
    sidebar_tour_head: 'Single-request trace tour',
    sidebar_ref_head: (n) => `Reference (${n} chapters)`,
    sidebar_toggle_aria: 'Expand / collapse',

    toast_first: 'Already at first',
    toast_last: 'Already at last',

    source_mode_local: 'Local VSCode',
    source_mode_prompt: (mode, project) =>
      `Current mode: ${mode}\n\n` +
      `Leave blank (default) → jump to GitHub at the locked commit and line\n` +
      `Enter local absolute path to ${project} repo → open in VSCode (requires VSCode installed)\n\n` +
      `Path example: /Users/<you>/git/<repo>`,
    source_mode_switched_local: 'Switched to local VSCode mode. Refresh to apply.',
    source_mode_switched_github: 'Switched to GitHub mode. Refresh to apply.',

    file_ref_verb_local: 'Open in VSCode',
    file_ref_verb_github: 'Open in GitHub',

    err_chapter_not_found_h1: 'Chapter not found',
    err_chapter_not_found_body: (id) => `Unknown chapter ID: <code>${id}</code>`,
    err_back_home: 'Back to home',
    err_load_failed_h1: 'Load failed',
    err_startup_failed_h1: 'Startup failed',

    home_stats_summary: (steps, chapters) => `<strong>${steps}</strong> tour steps + <strong>${chapters}</strong> reference chapters`,
    home_stats_analyzed: 'Analyzed version:',
    home_stats_focus: 'Focus:',
    home_trace_h2: (project) => `Recommended first read: trace one minimal request through ${project}`,
    home_trace_lede: (steps, project, traceTarget) =>
      `${steps}-step tour following the <strong>problem → naive idea → why it fails → ${project} solution</strong> arc. ` +
      `Built around one concrete <code>${traceTarget}</code> request walking the full ${project} stack.`,
    home_trace_cta: '→ Enter the tour (recommended first read)',
    home_trace_sample: 'Or jump to step 1 sample',
    home_arch_h2: 'Architecture overview',
    home_arch_play: '▶ Play one request flow',
    home_arch_reset: 'Reset',
    home_arch_caption: 'Click any layer to jump to that chapter; click "Play" to watch a request cross four layers.',
    home_tour_h2: (steps) => `Single-request trace tour (${steps} steps)`,
    home_tour_lede: (project) =>
      `~150 lines each, following the 8-section template: scene → problem → naive approach → why it fails → ${project} solution → code location → branch links → what you learned.`,
    home_ref_h2: (chapters) => `Reference (${chapters} chapters)`,
    home_ref_lede: 'Full subsystem reference as depth supplement to the tour. Each chapter is self-contained — jump in anywhere.',
    home_kbd_h2: 'Keyboard shortcuts',
    home_kbd_search: 'Focus search',
    home_kbd_next_prev: 'Next / previous chapter',
    home_kbd_theme: 'Toggle dark / light theme',
    home_kbd_home: 'Back to home',
    home_kbd_close: 'Close popup / search results',

    addendum_banner_q_prefix: 'This section answers: ',
    addendum_banner_back: (parent) => `↑ Back to ${parent}`,

    gloss_back_btn: '‹ Back',
    gloss_back_title: 'Back to previous (←)',
    gloss_close_title: 'Close (Esc)',
    gloss_reset_btn: 'Reset',
    gloss_reset_title: 'Clear local "viewed" history',
    gloss_no_definition: '*(no definition)*',
    gloss_english_label: 'Original name',
    gloss_chinese_label: '',           // empty: hides the row in English mode
    gloss_source_label: 'Source',
    gloss_hover_tooltip: (termKey) => `View definition of "${termKey}"`,
    gloss_open_file: (path) => `Open ${path}`,
    gloss_viewed_count: (viewed, total) => `Viewed ${viewed} / ${total} terms`,
  },
};

export const T = STRINGS[document.documentElement.lang.startsWith('en') ? 'en' : 'zh'];
