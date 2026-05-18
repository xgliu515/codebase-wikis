# Trace 步骤 16 —— 循环采样—decode，什么时候该停？

## 1. 当前情境

此刻处于 `run_sampled_generation()`（`ds4_cli.c:462`）内部。步骤 15 已经完成了
第 1 个 decode：新 token 被 `ds4_session_eval()` 喂进引擎，KV 缓存追加了一行，
下一轮的 logits 已经就绪在 session 里。

当前状态快照：

```
session.pos  = len(prompt) + 1     // prompt 占的位 + 刚生成的 token 1
generated    = 1                   // 已生成 token 计数
max_tokens   = 3                   // 来自 -n 3，已经被 room 截断过
rng          = <上一轮更新后的状态>  // 伪随机数生成器，非 const
```

`max_tokens` 在循环开始前就被 `room` 截断过（`ds4_cli.c:496-499`）：

```c
int room = ds4_session_ctx(session) - ds4_session_pos(session);
if (room <= 1) max_tokens = 0;
else if (max_tokens > room - 1) max_tokens = room - 1;
```

现在程序即将进入 `while` 循环的第 2 次迭代，目标是把 `generated` 从 1 推到 3。

## 2. 问题

这一步必须回答两件事：

1. **循环体做什么**：每次迭代如何从 logits 出发，得到一个 token、打印出来、
   再把状态推进，让下一次迭代继续？
2. **何时停下来**：生成循环必须有明确的停止条件，否则会无限输出，或悄悄越界
   写坏 KV 缓存，或在用户按下 Ctrl-C 后不响应。

停止条件至少要覆盖四种情形：
- 已生成 `n_predict` 个 token（用户给的上限）。
- 模型输出 EOS（模型自己认为该停了）。
- 上下文窗口满（没有剩余 slot 写入新 KV 行）。
- 用户 Ctrl-C 中断。

## 3. 朴素思路

最直觉的写法：

```c
for (int i = 0; i < n_predict; i++) {
    int token = sample(logits);
    if (token == EOS) break;
    print(token);
    eval(token);   // 把 token 喂进去，更新 logits
}
```

逻辑上完全正确。`n_predict` 控制上限，EOS 控制提前退出，eval 推进状态。
这思路在 ds4 里基本就是这么干的。问题出在几个被这个草稿忽略掉的细节。

## 4. 为什么朴素思路会崩

**第一个坑：context window 溢出。**

`n_predict` 是用户给的请求级参数，`ctx_size` 是分配 KV 缓存时的物理上限。
如果用户写 `-n 500000 --ctx 32768`，朴素循环会在生成几千 token 后安静地把
KV 缓存写越界——因为 `ds4_session_eval` 内部每次要追加一行，但缓存已经满了。
结果不是崩溃报错，而是悄悄写坏后面的内存，产生乱码甚至段错误。

**第二个坑：Ctrl-C 不响应。**

Metal GPU kernel 或 CUDA kernel 在运行时，C 代码陷在同步等待里，信号处理器
`cli_sigint_handler`（`ds4_cli.c:59`）会被调用，但朴素 `for` 循环从来不检查
这个标志，用户得等到当前 kernel 结束才有机会退出——实际体感是「卡住了」。

**第三个坑：EOS 在推测解码批里。**

如果开启了 MTP 推测解码，一次 `ds4_session_eval_speculative_argmax` 会接受
多个 token（`toks[0..ntok-1]`）。EOS 可能出现在这批 token 的中间位置——
朴素思路里直接 `break` 会跳过对 EOS 之前那些 token 的打印。

## 5. DwarfStar 4 的做法

`run_sampled_generation()` 的 `while` 循环（`ds4_cli.c:505-552`）把四个停止条件
全部显式处理：

<svg viewBox="0 0 760 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="run_sampled_generation while-loop flowchart with four stop conditions">
  <defs>
    <marker id="ar16-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar16-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/>
    </marker>
    <marker id="ar16-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#16a34a"/>
    </marker>
  </defs>
  <rect x="170" y="10" width="380" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="360" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">loop condition check</text>
  <text x="360" y="50" text-anchor="middle" font-size="11" fill="#64748b">generated &lt; max_tokens  AND  !cli_interrupt_requested()</text>
  <text x="560" y="36" text-anchor="start" font-size="10" fill="#dc2626">→ 假：停止</text>
  <line x1="360" y1="60" x2="360" y2="82" stroke="#16a34a" stroke-width="1.2" marker-end="url(#ar16-3)"/>
  <text x="366" y="77" font-size="10" fill="#16a34a">满足，继续</text>
  <rect x="130" y="82" width="460" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="360" y="99" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">ds4_session_sample</text>
  <text x="360" y="118" text-anchor="middle" font-size="10" fill="#64748b">(session, temperature, top_p, min_p, &amp;rng)</text>
  <line x1="360" y1="126" x2="360" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar16-1)"/>
  <polygon points="260,148 460,148 460,188 260,188" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="360" y="170" text-anchor="middle" font-size="11" font-weight="600" fill="#dc2626">token == ds4_token_eos ?</text>
  <line x1="460" y1="168" x2="560" y2="168" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar16-2)"/>
  <rect x="560" y="152" width="140" height="32" rx="5" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="630" y="173" text-anchor="middle" font-size="11" fill="#dc2626">break（EOS 停止）</text>
  <text x="462" y="163" font-size="10" fill="#dc2626">YES</text>
  <line x1="360" y1="188" x2="360" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar16-1)"/>
  <text x="342" y="205" text-anchor="end" font-size="10" fill="#64748b">NO</text>
  <polygon points="160,210 560,210 560,256 160,256" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="360" y="228" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">temperature ≤ 0  AND  mtp_draft_tokens &gt; 1</text>
  <text x="360" y="248" text-anchor="middle" font-size="10" fill="#64748b">AND  DS4_MTP_SPEC_DISABLE 未设 ?</text>
  <line x1="560" y1="233" x2="680" y2="233" stroke="#0d9488" stroke-width="1.2" marker-end="url(#ar16-3)"/>
  <text x="562" y="228" font-size="10" fill="#0d9488">YES</text>
  <rect x="600" y="210" width="140" height="46" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="670" y="228" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">eval_speculative</text>
  <text x="670" y="243" text-anchor="middle" font-size="10" fill="#64748b">_argmax</text>
  <text x="670" y="256" text-anchor="middle" font-size="10" fill="#64748b">toks[0..ntok-1]</text>
  <line x1="360" y1="256" x2="360" y2="278" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar16-1)"/>
  <text x="342" y="273" text-anchor="end" font-size="10" fill="#64748b">NO</text>
  <rect x="170" y="278" width="380" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="360" y="295" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">ds4_session_eval(token)</text>
  <text x="360" y="308" text-anchor="middle" font-size="10" fill="#64748b">toks = {token},  ntok = 1</text>
  <line x1="670" y1="256" x2="670" y2="296" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="670" y1="296" x2="552" y2="296" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar16-1)"/>
  <line x1="360" y1="314" x2="360" y2="336" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar16-1)"/>
  <rect x="100" y="336" width="520" height="80" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="360" y="353" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">for j in 0..ntok-1:</text>
  <text x="360" y="371" text-anchor="middle" font-size="11" fill="#64748b">if toks[j] == EOS → stop=true; break</text>
  <text x="360" y="389" text-anchor="middle" font-size="11" fill="#64748b">token_printer_write_text(piece);  generated++</text>
  <text x="360" y="407" text-anchor="middle" font-size="11" fill="#64748b">if generated ≥ max_tokens → break</text>
  <line x1="360" y1="416" x2="360" y2="438" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar16-1)"/>
  <polygon points="220,438 500,438 500,472 220,472" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="360" y="460" text-anchor="middle" font-size="11" font-weight="600" fill="#dc2626">stop == true ?</text>
  <line x1="500" y1="455" x2="590" y2="455" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar16-2)"/>
  <rect x="590" y="440" width="130" height="30" rx="5" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="655" y="460" text-anchor="middle" font-size="11" fill="#dc2626">break（批内 EOS）</text>
  <text x="502" y="450" font-size="10" fill="#dc2626">YES</text>
  <line x1="360" y1="472" x2="360" y2="510" stroke="#16a34a" stroke-width="1.2" marker-end="url(#ar16-3)"/>
  <text x="342" y="498" text-anchor="end" font-size="10" fill="#64748b">NO</text>
  <rect x="210" y="510" width="300" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="360" y="530" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">回到 loop condition check ↑</text>
  <line x1="360" y1="540" x2="360" y2="565" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="565" x2="110" y2="565" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="110" y1="565" x2="110" y2="35" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="110" y1="35" x2="170" y2="35" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar16-3)"/>
</svg>
<span class="figure-caption">图 T16.1 ｜ run_sampled_generation while 循环流程图：四个显式停止条件与推测解码分支</span>

<details>
<summary>ASCII 原版</summary>

```
          loop condition check
          ┌──────────────────────────────────────┐
          │ generated < max_tokens               │
          │   AND !cli_interrupt_requested()      │
          └────────────────┬─────────────────────┘
                           | 满足，继续
                           v
              ds4_session_sample(session, temperature,
                                  top_p, min_p, &rng)
                           |
                           v
                 token == ds4_token_eos?
                    YES --> break (EOS 停止)
                    NO  |
                        v
            temperature <= 0 AND mtp_draft_tokens > 1
            AND DS4_MTP_SPEC_DISABLE 未设?
              YES --> ds4_session_eval_speculative_argmax
                      返回 toks[0..ntok-1]
              NO  --> ds4_session_eval(token)
                      toks = {token}, ntok = 1
                           |
                           v
              for j in 0..ntok-1:
                if toks[j] == EOS --> stop=true; break
                token_printer_write_text(piece)
                generated++
                if generated >= max_tokens --> break
                           |
              if stop --> break (批内 EOS 停止)
                           |
                   回到 loop condition
```

</details>

四个停止条件对应的代码位置：

| 停止原因 | 代码位置 |
|----------|----------|
| `generated >= max_tokens` | `ds4_cli.c:505`（while 条件）及 `ds4_cli.c:549` |
| EOS token（采样到） | `ds4_cli.c:508` |
| EOS token（推测批内） | `ds4_cli.c:539-541` |
| 上下文满（room <= 1） | `ds4_cli.c:498`（进循环前，max_tokens 截 0） |
| Ctrl-C | `ds4_cli.c:505`（while 条件右半部分） |

**对我们这条 trace：**

`temperature = 1.0f > 0`，所以 `ds4_cli.c:512` 的 MTP 推测解码分支不走，
每次迭代都走普通 `ds4_session_eval`，`ntok = 1`。循环运行 3 次，`generated`
从 0 增到 3，`while (generated < 3)` 变为假，循环结束。

**关于推测解码分支（本 trace 不走）：**

当 `temperature <= 0.0f`（贪心）且引擎装载了 MTP 草稿头（`ds4_engine_mtp_draft_tokens > 1`）时，
`ds4_session_eval_speculative_argmax`（`ds4.h:178`）一次性投机生成多个 token，
由引擎内部验证并接受其中连续正确的前缀，返回实际接受数量 `ntok`。这条路径
`temperature == 0` 才激活，与本 trace 互斥。

## 6. 代码位置

按阅读顺序：

- `ds4_cli.c:496-499` —— `room` 计算，`max_tokens` 被上下文窗口截断。
- `ds4_cli.c:501-502` —— RNG 种子初始化（time / pid / clock 混合）。
- `ds4_cli.c:505` —— `while` 条件：`generated < max_tokens && !cli_interrupt_requested()`。
- `ds4_cli.c:506-507` —— `ds4_session_sample(session, temperature, 0, top_p, min_p, &rng)`，采样出下一个 token。
- `ds4_cli.c:508` —— EOS 即时检查，`token == ds4_token_eos(engine)`。
- `ds4_cli.c:512-535` —— 推测解码分支（`temperature <= 0 && mtp_draft_tokens > 1`）vs 普通 eval 分支。
- `ds4_cli.c:528-534` —— 普通路径：`ds4_session_eval(session, token, err, sizeof(err))`，`toks[0]=token, ntok=1`。
- `ds4_cli.c:538-550` —— 批内打印循环：对 `toks[0..ntok-1]` 检查 EOS、打印文本、递增 `generated`。
- `ds4_cli.c:554` —— 循环结束后 `generation_done(&printer)`，收尾换行与 flush。
- `ds4_cli.c:555` —— `cli_interrupt_requested()` 为真时 `cli_interrupt_clear()`，清除中断标志。
- `ds4_cli.c:559-563` —— 打印 prefill/decode 吞吐量计时。
- `ds4.h:147` —— `ds4_token_eos(ds4_engine *e)` 声明。
- `ds4.h:184-185` —— `ds4_session_pos(s)` / `ds4_session_ctx(s)` 声明。
- `ds4.h:178-181` —— `ds4_session_eval_speculative_argmax()` 签名与参数说明。
- `ds4_cli.c:57-69` —— `cli_interrupted` volatile 标志与 SIGINT 处理器。

## 7. 分支与延伸

- 本 trace 因 `temperature > 0` 绕开了推测解码。如果换成 `--temp 0` 且模型有
  MTP 草稿头，decode 循环的每次迭代会批量接受多个 token，吞吐量可以显著提升。
  推测解码的原理、MTP 草稿头结构、接受率分析详见
  [第 12 章 推测解码与 MTP](12-speculative-mtp.md)。
- `ds4_session_ctx`、`ds4_session_pos` 背后是 KV 缓存的 slot 管理。`ctx_size`
  决定物理分配，`pos` 是当前已写入的行数。两者如何影响内存布局和 SWA 窗口
  见 [第 6 章 引擎与会话](06-engine-session.md)。
- 如果从 HTTP 服务器端（`ds4-server`）发起请求，停止条件里还多了「客户端断开连接」
  和「请求级 `max_tokens` 覆盖」，由服务器层在回调里注入，并非 CLI 的 SIGINT
  机制。这套机制的细节见 [第 13 章 HTTP 服务器与 Agent API](13-http-server-api.md)。
- REPL 模式（`run_repl`）里的同名 `while` 循环（`ds4_cli.c:963`）结构几乎相同，
  多了「重用会话跨轮次」的逻辑，会话的生命周期管理同样参考
  [第 6 章 引擎与会话](06-engine-session.md)。

## 8. 走完这一步你脑子里应该多了什么

1. `run_sampled_generation` 的 `while` 循环有四个显式停止条件：计数上限
   `max_tokens`、EOS token、上下文 room 截断（进循环前就处理）、Ctrl-C 信号标志——
   缺任何一个都会造成越界、乱码或假死。
2. 上下文满不是在循环内实时检查的，而是在循环**前**把 `max_tokens` 截断成
   `room - 1`，让计数上限条件自然覆盖这种情况，不引入额外的分支。
3. 推测解码路径（`temperature <= 0 && mtp_draft_tokens > 1`）和普通 eval 路径
   共用同一个批内打印循环，差别只是 `ntok` 的值——1 还是多个。
4. 本 trace 因 `temperature = 1.0f` 始终走普通 eval，每次迭代消耗一个 token slot，
   `generated` 从 0 增到 3，循环条件恰好变假，干净退出。
5. `cli_interrupt_requested()` 是对 `volatile sig_atomic_t` 的读取，POSIX 保证
   信号处理器写入该类型是安全的；每次迭代的循环条件都会轮询它，响应延迟不超
   过一个 decode 步骤的时间。
