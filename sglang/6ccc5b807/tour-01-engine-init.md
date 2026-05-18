# Trace 步骤 01 —— 几十个启动参数，怎么收敛成一份「真相」？

## 1. 当前情境

我们刚执行到这一行：

```python
engine = Engine(model_path="meta-llama/Llama-3.2-1B-Instruct")
```

此刻还什么都没发生：没有进程被拉起，没有显存被占用，没有权重被加载。Python 解释器只是进入了 `Engine.__init__`（`python/sglang/srt/entrypoints/engine.py:199`）。我们手里只有一个 kwarg：`model_path`。但 SGLang 的运行时行为由**上百个**可调项决定——attention backend 选哪个、留多少显存给 KV cache、要不要开 CUDA graph、张量并行多少路……这些此刻全都没定。

## 2. 问题

`Engine` 内部由三个子进程 + 一个 `ModelRunner` + 一个 KV 池 + 一个调度器组成（后面 17 步会逐个见到）。这些组件**各自**都需要知道一大堆配置。问题是：

- 用户只传了一个 `model_path`，其余上百项得有合理默认值；
- 有些项用户没传、但**能从模型本身推断**（比如 1B 模型的 dtype、上下文长度、是不是 MoE）；
- 有些项之间**互相约束**（开了某个 attention backend 就不能开某种量化；`dp_size * tp_size` 不能超过可见 GPU 数）；
- 这份配置要被**序列化后发给子进程**——子进程在另一个地址空间，不能共享 Python 对象。

所以这一步要解决的是：**把「用户给的 + 默认的 + 从模型推断的 + 互相校验过的」配置，收敛成一份所有组件都认的、可跨进程传输的「单一真相」。**

## 3. 朴素思路

最直接的写法：让每个组件自己读配置。`Scheduler` 要 attention backend，就自己读环境变量或自己设默认值；`ModelRunner` 要 dtype，就自己去 HuggingFace config 里翻。配置不集中，谁用谁取。

这很自然——「就近取用」是大多数人写配置的第一反应，省得设计一个大对象。

## 4. 为什么朴素思路会崩

一旦组件分布在**多个进程**里，「就近取用」立刻崩：

- **不一致**：`TokenizerManager` 在主进程推断出上下文长度是 4096，`Scheduler` 在子进程重新推断时读到的环境变量变了，算出 8192。两个进程对同一个模型的认知不一致，KV 池会按 8192 分配、调度器按 4096 截断，请求长度一过 4096 就出玄学错误。
- **校验无处可做**：`tp_size=4` 但机器只有 2 张卡，这种错误必须在**起进程之前**就拦住。如果配置散落各处，等到第 3 个子进程崩了你才知道，前两个进程已经占了显存。
- **没法传给子进程**：`run_scheduler_process` 是用 `multiprocessing` 在新进程里跑的。新进程不继承主进程的 Python 对象，你必须把配置**打包成能 pickle 的东西**显式传过去。散落的配置根本没法打包。

核心矛盾：配置的「推断 + 校验」必须**只做一次、在起进程之前做完**，然后冻结。

## 5. SGLang 的做法

SGLang 把所有配置收敛进一个 `dataclass`——`ServerArgs`（`python/sglang/srt/server_args.py`）。`Engine.__init__` 的头几行就是在造它：

```python
# engine.py:209-219
if "server_args" in kwargs:
    server_args = kwargs["server_args"]
else:
    if "log_level" not in kwargs:
        kwargs["log_level"] = "error"   # Engine 默认不打日志
    server_args = self.server_args_class(**kwargs)
self.server_args = server_args
```

`ServerArgs` 是一个有上百个字段的 `dataclass`。关键在它的 `__post_init__`：dataclass 构造完字段后，`__post_init__` 自动触发，在里面完成三件事——

1. **填默认值**：用户没传的项给默认值（比如 `mem_fraction_static`、`attention_backend`）；
2. **从模型推断**：读 HuggingFace 的 `config.json`，推断 dtype、上下文长度、是否 MoE、词表大小，回填进字段；
3. **交叉校验**：检查 `tp_size`、`dp_size` 与可见 GPU 数是否相容，检查 backend 与量化是否冲突，不合法就**当场抛错**——此时还没起任何进程，失败代价为零。

`__post_init__` 跑完，`server_args` 就**冻结**了：它是一份普通的 dataclass 实例，能被 pickle，能整体塞进 `multiprocessing` 的参数里发给子进程。从这一刻起，主进程、`TokenizerManager`、`Scheduler`、`DetokenizerManager` 看到的是**同一份**配置的拷贝——它们不会再各自推断，因此不会不一致。

<svg viewBox="0 0 600 392" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ServerArgs configuration convergence flow">
<defs>
<marker id="t1ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="170" y="16" width="260" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
<text x="300" y="41" text-anchor="middle" font-size="13" fill="currentColor">Engine(model_path=...)</text>
<line x1="300" y1="56" x2="300" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t1ar)"/>
<rect x="90" y="88" width="420" height="122" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="300" y="111" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ServerArgs(**kwargs) · __post_init__</text>
<text x="116" y="137" font-size="11" fill="#64748b">① 填默认值（用户没传的项）</text>
<text x="116" y="159" font-size="11" fill="#64748b">② 从 HF config 推断 dtype / 上下文长度 / MoE</text>
<text x="116" y="181" font-size="11" fill="#64748b">③ 交叉校验 tp / dp / backend / quant</text>
<text x="132" y="199" font-size="10" fill="#dc2626">不合法当场抛错（此刻还没占任何显存）</text>
<line x1="300" y1="210" x2="300" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t1ar)"/>
<rect x="130" y="242" width="340" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="300" y="269" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">server_args — 冻结、可 pickle 的单一真相</text>
<line x1="300" y1="286" x2="300" y2="316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t1ar)"/>
<rect x="160" y="318" width="280" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
<text x="300" y="343" text-anchor="middle" font-size="12" fill="currentColor">拷贝分发给三个子进程（步骤 02）</text>
</svg>
<span class="figure-caption">图 T1.1 ｜ 几十个启动参数如何在 ServerArgs.__post_init__ 里收敛成一份冻结的单一真相</span>

<details>
<summary>ASCII 原版</summary>

```text
  Engine(model_path=...)
        │
        ▼
  ServerArgs(**kwargs)            <- 用户给的 + 默认值
        │  __post_init__
        ├─ 从 HF config 推断 dtype / 上下文长度 / MoE ...
        ├─ 交叉校验 tp/dp/backend/quant  -> 不合法当场抛错
        ▼
  server_args  (冻结、可 pickle 的单一真相)
        │
        └──> 拷贝分发给三个子进程  (步骤 02)
```

</details>

注意 `Engine.__init__` 紧接着就调用 `self._launch_subprocesses(server_args=server_args, ...)`（`engine.py:230-241`）——配置一冻结，立刻拿去起进程。`server_args_class` 是个类属性（`engine.py:194`），私有 fork 可以覆盖它换成自己的 `ServerArgs` 子类，这也是为什么它做成可替换的钩子。

## 6. 代码位置

按这个顺序读：

- 入口：`python/sglang/srt/entrypoints/engine.py:199` —— `Engine.__init__`。
- 造配置：`engine.py:209-219` —— 区分「直接传 server_args」和「从 kwargs 构造」两条路。
- 配置定义：`python/sglang/srt/server_args.py` —— `ServerArgs` dataclass，搜 `class ServerArgs` 和 `def __post_init__`，推断与校验逻辑都在 `__post_init__` 里。
- 冻结后去向：`engine.py:230-241` —— `_launch_subprocesses` 拿走 `server_args`（下一步细看）。

## 7. 分支与延伸

- `ServerArgs` 的完整字段分组、每个参数的含义 → [第 04 章 §ServerArgs](04-engine-and-processes.md#serverargs)
- 命令行 `python -m sglang.launch_server` 怎么把 argparse 参数变成 `ServerArgs` → [第 03 章 HTTP 服务器](03-http-server.md)
- attention backend 的选择与默认值推断 → [第 10 章 注意力后端](10-attention-backends.md)
- `mem_fraction_static` 如何决定 KV 池大小 → [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md)，也会在 [步骤 04](tour-04-size-kv-pool.md) 用到
- 张量/数据并行参数（`tp_size` / `dp_size`）的校验 → [第 13 章 分布式与并行执行](13-distributed.md)

## 8. 走完这一步你脑子里应该多了什么

1. `Engine` 的所有配置都收敛在**一个** `dataclass` —— `ServerArgs`，它是全系统的「单一真相」。
2. 默认值填充、从 HF config 推断、交叉校验，**全部在 `ServerArgs.__post_init__` 里一次性做完**，且发生在任何进程/显存被占用**之前**——配置错误的失败代价为零。
3. `ServerArgs` 必须是**可 pickle** 的，因为它要被拷贝着发给三个独立进程；这是「单一真相」能跨进程成立的前提。
4. 配置一冻结，`Engine.__init__` 立刻进入 `_launch_subprocesses`——下一步三个进程就要起来了。
