# Trace 步骤 17 —— token 怎么变回文字，进程怎么干净退出？

## 1. 当前情境

步骤 16 的 `while` 循环刚结束。`generated = 3`，循环条件 `generated < max_tokens`
变假，正常退出（本 trace 不是 EOS，不是 Ctrl-C）。此时：

```
generated    = 3          // 已向 token_printer 写入了 3 次文本片段
session.pos  = len(prompt) + 3
printer.fp   = stdout
engine       = <加载中的 ds4_engine，持有 mmap>
session      = <持有 KV 缓存与 Metal graph>
```

这一步回顾 token → 文字的转换机制，以及从生成完成到进程退出的整条收尾路径：
`generation_done` 收尾 → `ds4_session_free` 释放会话 → `ds4_engine_close` 释放引擎 →
`model_close` 内部 `munmap` → `return rc` 进程退出。

## 2. 问题

两件独立但紧密相连的事：

**第一件：token → 文字。**
整数 token id 是什么意思？直接用词表里的字符串吗？
中文「你好」分词后可能横跨多个 token，每个 token 只是一个字节片段——
如果直接输出，屏幕上会出现乱码（无效 UTF-8 序列）。
此外，thinking 模式下模型会输出 `<think>...</think>` 包裹的推理过程，
这些文字需要在流式打印时着色区分，而不能等到全部生成完才后处理。

**第二件：干净退出。**
`ds4_engine` 打开时做了三件重资源操作：`mmap` 把整个 GGUF 文件（几十 GiB）
映射进地址空间，Metal 分配了 GPU 上的权重缓冲与图状态，线程池启动了若干
工作线程。进程退出时必须按顺序释放，否则：
- Metal 缓冲未释放 → GPU 内存泄漏（在多进程或测试场景下可见）。
- mmap 不手动 unmap → 文件描述符泄漏，且 OS 要等进程退出才回收地址空间。
- 线程池未 join → 工作线程残留，写入已释放内存。

## 3. 朴素思路

**token → 文字：** 从词表里取字符串，直接 `puts`。
**退出：** 函数返回，OS 自动回收所有资源。

两个思路在简单场景下都能跑，但各有一个致命的细节问题。

## 4. 为什么朴素思路会崩

**关于 token → 文字：**

GPT-2/DeepSeek 的 BPE 词表并不直接存 UTF-8 字节，而是用一套「字节到 Unicode
码点」的映射来让词表里所有字节都是可打印字符。例如，空格被编码成全宽字符 `Ġ`
（U+0120），原始字节 0x00 被编码成某个专用码点。
直接把词表字符串输出到终端，会得到一堆 Unicode 符号而不是原始文本。

此外，中文汉字（如「你」「好」）的 UTF-8 编码是 3 字节，BPE 切割点可能落在
字节边界上——第 1 个 token 是「你」的前 2 字节，第 2 个 token 是「好」的后 1 字节
加「的」的第 1 字节。如果每个 token 的片段独立输出，屏幕会先看到一个非法 UTF-8
序列，再看到另一个——终端的 UTF-8 解码器会显示乱码或跳字。

**关于退出：**

「OS 自动回收」对内存泄漏通常没问题，但有两个场景会崩：
1. **单元测试或嵌入式使用**：测试框架在同一个进程里多次调用 `ds4_engine_open` /
   `ds4_engine_close`。如果 Metal 缓冲不显式释放，Metal 驱动会报「资源已耗尽」。
2. **mmap 大文件**：如果有多个进程共享同一个 `MAP_SHARED` 的 GGUF，不手动
   `munmap` 会让脏页在系统缓存里多停留，给其他进程造成内存压力。

## 5. DwarfStar 4 的做法

### token → 文字：`ds4_token_text` 的 GPT-2 反编码

`ds4_token_text`（`ds4.c:15046`）对每个 token 做两步转换：

<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_token_text GPT-2 byte decoding pipeline: token id to raw UTF-8 bytes via codepoint reverse lookup">
  <defs>
    <marker id="ar17a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="10" width="200" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="33" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">token id</text>
  <line x1="320" y1="46" x2="320" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17a)"/>
  <rect x="80" y="70" width="480" height="42" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="87" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">vocab.token[id]</text>
  <text x="320" y="104" text-anchor="middle" font-size="10" fill="#64748b">词表中存储的 UTF-8 字符串（GPT-2 编码格式，可打印 Unicode 化）</text>
  <line x1="320" y1="112" x2="320" y2="136" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17a)"/>
  <rect x="80" y="136" width="480" height="42" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="153" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">utf8_decode_one  →  取 Unicode 码点</text>
  <text x="320" y="170" text-anchor="middle" font-size="10" fill="#64748b">逐字符迭代，提取每个字符的 Unicode 码点值</text>
  <line x1="320" y1="178" x2="320" y2="202" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17a)"/>
  <rect x="80" y="202" width="480" height="42" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="219" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">gpt2_codepoint_to_byte</text>
  <text x="320" y="236" text-anchor="middle" font-size="10" fill="#64748b">反查：码点 → 原始字节值（ds4.c:15021）</text>
  <line x1="320" y1="244" x2="320" y2="264" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17a)"/>
  <rect x="160" y="264" width="320" height="28" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="283" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">out[]  —  原始字节数组（真正的 UTF-8 字节）</text>
</svg>
<span class="figure-caption">图 T17.1 ｜ ds4_token_text 的 GPT-2 字节反编码：token id → 词表字符串 → 逐码点反查 → 原始 UTF-8 字节数组</span>

<details>
<summary>ASCII 原版</summary>

```
token id
   |
   v
vocab.token[id]  <- 词表中存储的 UTF-8 字符串（GPT-2 编码格式）
   |
   | 逐字符解码：utf8_decode_one -> 取 Unicode 码点
   v
gpt2_codepoint_to_byte  <- 反查：码点 -> 原始字节值
   |
   v
out[]  <- 原始字节数组（真正的 UTF-8 字节）
```

</details>

`gpt2_codepoint_to_byte`（`ds4.c:15021`）实现了 GPT-2 的字节映射逆操作：
可打印 ASCII（33-126）和 Latin-1 部分范围直接映射为自身；
其余 256 个字节被映射到 256 + 序号的码点，函数通过线性扫描反查原始字节。

返回值是 `xmalloc` 分配的裸字节数组（调用方负责 `free`），`*len` 是字节长度。
这样，「你」的前 2 字节 token 和「好」的后 1 字节 token 分别返回字节片段，
两个片段拼在一起就是合法的 UTF-8 序列。终端拿到的每个 `fwrite` 调用都只是
推入原始字节；TCP/终端的流语义保证字节到达顺序，UTF-8 解码器会在字节积累完整
码点后再渲染。

### thinking 段的流式着色：`token_printer`

`token_printer`（`ds4_cli.c:330`）是一个带状态的流式过滤器：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="token_printer_write_text dispatch: format_thinking path with think-tag scanning vs direct fwrite path">
  <defs>
    <marker id="ar17b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="10" width="360" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="26" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">token_printer_write_text(p, piece, len)</text>
  <text x="380" y="40" text-anchor="middle" font-size="10" fill="#64748b">ds4_cli.c:435</text>
  <line x1="380" y1="46" x2="380" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17b)"/>
  <polygon points="380,70 520,100 380,130 240,100" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="98" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">format_thinking?</text>
  <line x1="240" y1="100" x2="100" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17b)"/>
  <text x="170" y="93" text-anchor="middle" font-size="10" fill="#dc2626">NO</text>
  <rect x="10" y="82" width="90" height="36" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="55" y="97" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">fwrite</text>
  <text x="55" y="110" text-anchor="middle" font-size="9" fill="#64748b">直接写 fp</text>
  <line x1="520" y1="100" x2="600" y2="100" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <text x="560" y="93" text-anchor="middle" font-size="10" fill="#16a34a">YES</text>
  <line x1="380" y1="130" x2="380" y2="155" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17b)"/>
  <rect x="80" y="155" width="600" height="42" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="172" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">token_printer_process(p, text, len, finish=false)</text>
  <text x="380" y="189" text-anchor="middle" font-size="10" fill="#64748b">流式扫描 &lt;think&gt; / &lt;/think&gt; 标签，pending[16] 暂存跨 token 的不完整标签前缀</text>
  <line x1="380" y1="197" x2="380" y2="222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17b)"/>
  <polygon points="380,222 520,252 380,282 240,252" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="250" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">in_think？</text>
  <line x1="240" y1="252" x2="140" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17b)"/>
  <text x="190" y="244" text-anchor="middle" font-size="10" fill="#dc2626">false</text>
  <rect x="20" y="234" width="120" height="36" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="80" y="249" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">reset_color</text>
  <text x="80" y="262" text-anchor="middle" font-size="9" fill="#64748b">\x1b[0m 恢复色</text>
  <line x1="520" y1="252" x2="620" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17b)"/>
  <text x="570" y="244" text-anchor="middle" font-size="10" fill="#7c3aed">true</text>
  <rect x="620" y="234" width="120" height="36" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="680" y="249" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">set_grey</text>
  <text x="680" y="262" text-anchor="middle" font-size="9" fill="#7c3aed">\x1b[90m 灰色</text>
</svg>
<span class="figure-caption">图 T17.2 ｜ token_printer_write_text 的两条路径：format_thinking=NO 时直接 fwrite；YES 时经 token_printer_process 扫描 think 标签并着色</span>

<details>
<summary>ASCII 原版</summary>

```
token_printer_write_text(p, piece, len)
          |
          v   format_thinking?
    YES --+--> token_printer_process(p, text, len, false)
          |         |
          |         | 扫描 <think> / </think> 标签
          |         | pending[16] 暂存跨 token 的不完整标签前缀
          |         v
          |    in_think=true  -> token_printer_set_grey -> \x1b[90m 灰色
          |    in_think=false -> token_printer_reset_color -> \x1b[0m
          |
    NO  --+--> fwrite(text, 1, len, fp)  直接写
```

</details>

`pending[16]`（`ds4_cli.c:337`）是 `token_printer` 的跨 token 缓冲区：
当当前片段以 `<` 开头且可能是 `<think>` 或 `</think>` 的前缀时，暂存到 `pending`，
等下一个片段到达再拼接判断。这解决了 `<think>` 标签被 BPE 切成两个 token 的边界问题。

`generation_done`（`ds4_cli.c:425`）在循环结束后调用：
- 调用 `token_printer_finish`，以 `finish=true` 再走一遍 `token_printer_process`，
  把 `pending` 里残留的片段强制输出。
- 调用 `token_printer_reset_color`，发送 `\x1b[0m` 恢复终端颜色。
- 如果最后一个字符不是换行，补一个 `\n`（`ds4_cli.c:428-430`），保证 shell
  提示符出现在新行上。
- 最后 `fflush(p->fp)`。

### 会话与引擎的释放顺序

`run_sampled_generation` 正常返回前（`ds4_cli.c:565`）：

```c
ds4_session_free(session);   // ds4_cli.c:565
return 0;
```

`ds4_session_free`（`ds4.c:17356`）释放：
- Metal backend：`metal_graph_free(&s->graph)`，释放 GPU 上的 KV 缓存缓冲与
  Metal 命令队列引用。
- CPU backend：`kv_cache_free`、`cpu_decode_scratch_free`。
- 所有路径都：`token_vec_free(&s->checkpoint)`、`free(s->logits)`、`free(s->mtp_logits)`。
- 最后 `free(s)` 释放结构体本身。

`session` 释放后，控制流沿调用栈返回 `run_generation`（`ds4_cli.c:762`），
再返回 `main()`（`ds4_cli.c:1374`），执行：

```c
ds4_engine_close(engine);    // ds4_cli.c:1376
free(cfg.prompt_owned);
return rc;
```

`ds4_engine_close`（`ds4.c:17292`）按顺序释放：

```text
weights_free(&e->weights)          // 释放量化权重元数据
vocab_free(&e->vocab)              // 释放词表字符串
ds4_threads_shutdown()             // join 线程池工作线程
model_close(&e->mtp_model)         // 若有 MTP 草稿模型
model_close(&e->model)             // 主模型：munmap + close(fd)
ds4_gpu_cleanup()                  // Metal/CUDA 设备级清理
ds4_release_instance_lock()        // 单实例锁释放
free(e)                            // 释放 engine 结构体
```

`model_close`（`ds4.c:1077`）内部是 `munmap((void *)m->map, m->size)` 加
`close(m->fd)`——这是整个生命周期里唯一的 `munmap` 调用，把步骤 02 映射进来的
几十 GiB GGUF 地址空间归还给内核。

整条 session → engine 释放链用 ASCII 图表示：

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Session and engine teardown sequence: generation_done then ds4_session_free then ds4_engine_close with munmap and process exit">
  <defs>
    <marker id="ar17c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="10" y="10" width="740" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="28" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">generation_done(&amp;printer)</text>
  <text x="380" y="46" text-anchor="middle" font-size="10" fill="#64748b">ds4_cli.c:425 — 收尾：flush pending、reset color、补换行、fflush(stdout)</text>
  <line x1="60" y1="54" x2="60" y2="80" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="60" y1="67" x2="75" y2="67" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="85" y="71" font-size="10" fill="#64748b">token_printer_finish  →  fflush(stdout)</text>
  <line x1="380" y1="54" x2="380" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17c)"/>
  <rect x="10" y="90" width="740" height="100" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/>
  <text x="380" y="108" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ds4_session_free(session)</text>
  <text x="380" y="123" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:17356 — 释放所有会话可变状态</text>
  <line x1="60" y1="127" x2="60" y2="170" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="60" y1="137" x2="75" y2="137" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="85" y="141" font-size="10" fill="currentColor">metal_graph_free / kv_cache_free</text>
  <text x="420" y="141" font-size="10" fill="#64748b">GPU/CPU KV 缓存</text>
  <line x1="60" y1="155" x2="75" y2="155" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="85" y="159" font-size="10" fill="currentColor">free(logits / mtp_logits)  +  free(checkpoint)  +  free(session)</text>
  <line x1="380" y1="190" x2="380" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17c)"/>
  <text x="380" y="212" text-anchor="middle" font-size="10" fill="#94a3b8">返回 main()</text>
  <rect x="10" y="218" width="740" height="190" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="380" y="236" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ds4_engine_close(engine)</text>
  <text x="380" y="251" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:17292 — 按序释放引擎所有资源</text>
  <line x1="60" y1="255" x2="60" y2="380" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="60" y1="265" x2="75" y2="265" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="85" y="269" font-size="10" fill="currentColor">weights_free / vocab_free</text>
  <line x1="60" y1="283" x2="75" y2="283" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="85" y="287" font-size="10" fill="currentColor">ds4_threads_shutdown()</text>
  <text x="420" y="287" font-size="10" fill="#64748b">join 线程池工作线程</text>
  <line x1="60" y1="301" x2="75" y2="301" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="85" y="305" font-size="10" fill="currentColor">model_close(&amp;model)</text>
  <line x1="100" y1="309" x2="100" y2="350" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2,2"/>
  <line x1="100" y1="319" x2="115" y2="319" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="125" y="323" font-size="10" fill="#ea580c" font-weight="600">munmap(gguf_map, size)</text>
  <text x="400" y="323" font-size="10" fill="#64748b">归还 GGUF 地址空间（步骤 02 mmap 的对称操作）</text>
  <line x1="100" y1="337" x2="115" y2="337" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="125" y="341" font-size="10" fill="currentColor">close(fd)</text>
  <line x1="60" y1="355" x2="75" y2="355" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar17c)"/>
  <text x="85" y="359" font-size="10" fill="currentColor">ds4_gpu_cleanup()  +  ds4_release_instance_lock()  +  free(engine)</text>
  <line x1="380" y1="408" x2="380" y2="432" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar17c)"/>
  <rect x="160" y="432" width="440" height="24" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="449" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">return rc  —  进程退出，屏幕上留下生成的文字</text>
</svg>
<span class="figure-caption">图 T17.3 ｜ 进程收尾全链路：generation_done 收尾输出 → ds4_session_free 释放 KV 缓存 → ds4_engine_close 释放权重/线程/munmap → 进程退出</span>

<details>
<summary>ASCII 原版</summary>

```
generation_done(&printer)
  |-- token_printer_finish  (flush pending, reset color, newline)
  |-- fflush(stdout)
ds4_session_free(session)
  |-- metal_graph_free / kv_cache_free  (GPU/CPU KV 缓存)
  |-- free(logits / mtp_logits)
  |-- free(session)
[返回 main]
ds4_engine_close(engine)
  |-- weights_free / vocab_free
  |-- ds4_threads_shutdown            (join 线程池)
  |-- model_close(&model)
  |     |-- munmap(gguf_map, size)    (归还 GGUF 地址空间)
  |     |-- close(fd)
  |-- ds4_gpu_cleanup
  |-- free(engine)
return rc   -->  进程退出，屏幕上留下 3 个 token 的文字
```

</details>

## 6. 代码位置

按阅读顺序：

- `ds4.c:15046` —— `ds4_token_text()` 实现：GPT-2 字节反编码，返回 `xmalloc` 字节数组。
- `ds4.c:15021` —— `gpt2_codepoint_to_byte()`：GPT-2 码点 → 原始字节的反查表。
- `ds4.c:14991` —— `utf8_decode_one()`：从词表 UTF-8 字符串逐字符取码点。
- `ds4_cli.c:330-339` —— `token_printer` 结构体：`pending[16]`、`in_think`、`color_open`、`use_color`。
- `ds4_cli.c:351-363` —— `token_printer_set_grey` / `token_printer_reset_color`：ANSI 转义序列。
- `ds4_cli.c:365-369` —— `token_printer_write_char`：单字节输出，`in_think` 时触发灰色。
- `ds4_cli.c:371-415` —— `token_printer_process`：流式扫描 `<think>` / `</think>`，`pending` 缓冲跨 token 标签前缀。
- `ds4_cli.c:417-423` —— `token_printer_finish`：以 `finish=true` 强制刷出 `pending`。
- `ds4_cli.c:425-433` —— `generation_done`：收尾换行与 `fflush`。
- `ds4_cli.c:435-442` —— `token_printer_write_text`：dispatch 到 `token_printer_process` 或直接 `fwrite`。
- `ds4_cli.c:544-547` —— 循环体内调用 `token_printer_write_text` 打印每个 token 片段。
- `ds4_cli.c:554` —— 循环结束后 `generation_done(&printer)`。
- `ds4_cli.c:565` —— `ds4_session_free(session)`，`run_sampled_generation` 最后一行。
- `ds4_cli.c:1376` —— `ds4_engine_close(engine)`，`main()` 清理阶段。
- `ds4.c:17356-17371` —— `ds4_session_free()` 实现：Metal graph / CPU KV 缓存按 backend 分支释放。
- `ds4.c:17292-17306` —— `ds4_engine_close()` 实现：按顺序释放 weights、vocab、线程池、model（含 munmap）、GPU。
- `ds4.c:1077-1085` —— `model_close()`：`munmap` + `close(fd)`，GGUF 地址空间的最终归还。
- `ds4.h:146` —— `ds4_token_text()` 声明。
- `ds4.h:152` —— `ds4_session_free()` 声明。
- `ds4.h:96` —— `ds4_engine_close()` 声明。

## 7. 分支与延伸

- `ds4_token_text` 做的 GPT-2 字节反编码与分词器加载时的正向编码是互逆的。
  词表如何从 GGUF 元数据加载、BPE merge ranks 怎么排序、special token 的
  字节标志（`vocab_token_is_literal_special` 检查的全宽竖线标记）见
  [第 5 章 分词器与对话模板](05-tokenizer-chat.md)。
- `ds4_session_free` 释放的 Metal graph 与 KV 缓存，正是步骤 07 `ds4_session_create`
  分配的。session 的整个生命周期（create → sync → eval × n → free）、
  session 与 engine 的所有权关系（engine 不持有 session，session 持有 engine 引用）
  见 [第 6 章 引擎与会话](06-engine-session.md)。
- `ds4_engine_close` 关闭的引擎贯穿了整个 trace 的步骤 02 到步骤 17。
  引擎加载时的三层结构（GGUF mmap → tensor 绑定 → Metal 权重缓冲上传）、
  引擎与后端的对应关系，以及「单实例锁」（`ds4_release_instance_lock`）的设计意图
  见 [第 1 章 架构总览](01-architecture-overview.md)。

---

trace 走完了。你从 `./ds4 -m DS4.gguf -p "你好" -n 3` 那行命令出发，跟着它走过
了全部 17 步：CLI 解析、GGUF mmap、张量绑定、分词、引擎创建、提示渲染、会话同步、
prefill 前向（注意力 + MoE + 压缩器）、logits head、首 token 采样、decode 循环、
token 反编码输出，最终进程干净退出。

如果想深入某个子系统，建议回到 [导览总览](tour-00-overview.md) 用交叉引用表
跳到对应的参考手册章节；如果想从头再走一遍，从
[步骤 01 —— CLI 解析](tour-01-cli-parse.md) 重新出发。

## 8. 走完这一步你脑子里应该多了什么

1. `ds4_token_text` 做的不是简单的词表查找，而是 GPT-2 字节反编码：
   词表存的是「可打印 Unicode 化」的字符，必须逐码点反查回原始字节，
   才能拼出合法的 UTF-8 输出。
2. `token_printer` 用 `pending[16]` 缓冲跨 token 的标签前缀，是流式着色
   `<think>` 段的关键——BPE 切割点随时可能落在 `<think>` 标签中间。
3. `generation_done` 负责三件收尾：flush `pending` 残留、恢复终端颜色、
   补换行——缺任何一件，shell 提示符都会出现在错误的位置或带有残留颜色。
4. `ds4_session_free` 必须在 `ds4_engine_close` 之前调用，因为 session 持有
   对 engine 内部资源（Metal 命令队列、权重缓冲引用）的访问；顺序颠倒会悬空指针。
5. `munmap` 发生在 `ds4_engine_close` → `model_close` 内部，是步骤 02 `mmap`
   的对称操作，也是进程退出前唯一一次主动归还 GGUF 地址空间的时机。
