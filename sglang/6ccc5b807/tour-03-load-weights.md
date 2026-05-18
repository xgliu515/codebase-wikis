# Trace 步骤 03 —— 几 GB 的模型权重，怎么搬上 GPU？

## 1. 当前情境

上一步三个进程已经起好。Scheduler 子进程刚被 `run_scheduler_process`（`python/sglang/srt/managers/scheduler.py:4029`）拉起，进入 `Scheduler.__init__`（`scheduler.py:340`）。调度器要驱动 GPU，但此刻 GPU 上还什么都没有——没有模型。`Scheduler.__init__` 内部会创建一个 `ModelRunner`（`python/sglang/srt/model_executor/model_runner.py:327`），由它负责把模型搞上 GPU。

## 2. 问题

磁盘上躺着的是 HuggingFace 格式的模型：一个目录，里面是 `config.json` 加若干 `*.safetensors` 权重分片。Llama-3.2-1B 大约 2.5 GB（bf16）。问题是：

- 这些权重要变成一个**能跑前向的 PyTorch 模型**——光有 tensor 不行，得有 `forward` 逻辑；
- 权重要从磁盘读进来，再搬到 **GPU 显存**；
- 权重文件里的张量名（HF 命名）和 SGLang 模型实现里的参数名**不一定一一对应**，得有映射；
- 这一步必须**精确记录用了多少显存**——因为下一步要拿「剩多少」去算 KV cache 池的大小。

## 3. 朴素思路

直接 `AutoModelForCausalLM.from_pretrained(path).cuda()`，HuggingFace 一行搞定，省心。

## 4. 为什么朴素思路会崩

`from_pretrained` 给你的是 HF 的模型实现。它能跑，但**跑不快**，原因是它的注意力、KV cache 行为是为「训练 / 通用推理」设计的：

- 它的 attention 模块不认识 SGLang 的**分页 KV cache**——SGLang 要求注意力按 page table 读写一个全局 KV 池（见 [步骤 15](tour-15-attention-kernel.md)），HF 的实现是每个请求一块连续 KV，对不上。
- 它不支持 SGLang 的**连续批处理**——HF 的 `generate` 假设一个固定 batch 跑到底，而 SGLang 的批是逐步变化的。
- 它没法接 SGLang 的可插拔注意力后端（FlashInfer / FlashMLA 等）。

换句话说：模型的**前向计算图**必须是 SGLang 自己写的版本，只有**权重数值**能从 HF 文件里拿。所以不能整体 `from_pretrained`，得「SGLang 的模型骨架 + HF 的权重数值」分开来。

## 5. SGLang 的做法

`ModelRunner.load_model`（`model_runner.py:1214`）做两件事的拼接：

1. **挑模型骨架**：根据 `config.json` 里的 `architectures` 字段（如 `LlamaForCausalLM`），到 `python/sglang/srt/models/` 里找 SGLang 自己实现的同名模型类（如 `python/sglang/srt/models/llama.py`）。这些实现的注意力层用的是 SGLang 的 `RadixAttention`、接的是可插拔后端。
2. **灌权重数值**：由 `python/sglang/srt/model_loader/` 负责，把 `*.safetensors` 里的张量逐个读出、按命名映射规则对应到模型骨架的参数上、`copy_` 进去，并放到 GPU。

<svg viewBox="0 0 620 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Model loading: SGLang skeleton plus HuggingFace weights">
<defs>
<marker id="t3ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="310" y="20" text-anchor="middle" font-size="11" fill="#94a3b8">磁盘上的 HuggingFace 模型</text>
<rect x="170" y="30" width="280" height="64" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
<text x="186" y="54" font-size="11" fill="currentColor">config.json</text>
<text x="320" y="54" font-size="10" fill="#64748b">architectures: LlamaForCausalLM</text>
<text x="186" y="80" font-size="11" fill="currentColor">*.safetensors</text>
<text x="320" y="80" font-size="10" fill="#64748b">权重张量（HF 命名）</text>
<line x1="250" y1="94" x2="180" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
<line x1="370" y1="94" x2="440" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
<rect x="50" y="134" width="240" height="86" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="170" y="158" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">① 选骨架</text>
<text x="170" y="180" text-anchor="middle" font-size="11" fill="#64748b">srt/models/llama.py</text>
<text x="170" y="202" text-anchor="middle" font-size="10" fill="#64748b">SGLang 自己的前向计算图</text>
<rect x="330" y="134" width="240" height="86" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="450" y="158" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">② 灌权重数值</text>
<text x="450" y="180" text-anchor="middle" font-size="11" fill="#64748b">srt/model_loader/</text>
<text x="450" y="202" text-anchor="middle" font-size="10" fill="#64748b">命名映射 + copy_ 到 GPU</text>
<line x1="170" y1="220" x2="290" y2="266" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
<line x1="450" y1="220" x2="330" y2="266" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
<rect x="140" y="270" width="340" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="310" y="297" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">GPU 显存里一个可跑前向的 SGLang 模型</text>
</svg>
<span class="figure-caption">图 T3.1 ｜ 加载 = SGLang 自己的模型骨架 + 从 HF safetensors 灌进来的权重数值</span>

<details>
<summary>ASCII 原版</summary>

```text
  磁盘上的 HF 模型
  ┌─────────────────────────┐
  │ config.json             │── architectures: LlamaForCausalLM
  │ model-00001.safetensors │── 权重张量 (HF 命名)
  └─────────────────────────┘
            │
   ┌────────┴─────────┐
   ▼                  ▼
 选骨架              load_model 灌权重
 srt/models/        srt/model_loader/
 llama.py           按命名映射 copy_ 到 GPU
   └────────┬─────────┘
            ▼
   GPU 显存里一个可跑前向的 SGLang 模型
```

</details>

`load_model` 跑完，模型权重已经在 GPU 显存里，`ModelRunner` 持有这个模型对象。关键的一点：`ModelRunner.__init__`（`model_runner.py:330`）在加载权重**前后各测一次显存占用**——`model_runner.py:725` 附近记录 `pre_model_load_memory`，加载后做差，就知道「权重 + 框架开销吃掉了多少显存」。这个数字马上要交给下一步。

模型类的 dtype（bf16 / fp16）、量化方式（本 trace 无量化）也在这一步根据 `server_args` 和 `config.json` 落实。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/managers/scheduler.py:340` —— `Scheduler.__init__`，内部创建 `ModelRunner`。
- `python/sglang/srt/model_executor/model_runner.py:330` —— `ModelRunner.__init__`，初始化主流程。
- `model_runner.py:1214` —— `load_model`，挑骨架 + 灌权重。
- `python/sglang/srt/model_loader/` —— 权重加载器，safetensors 读取与命名映射。
- `python/sglang/srt/models/llama.py` —— 一个具体模型骨架的实现，看它的注意力层怎么写。
- `model_runner.py:725` 附近 —— 加载前后的显存测量。

## 7. 分支与延伸

- `ModelRunner` 的完整初始化流程、模型骨架的组织方式 → [第 09 章 ModelRunner 与前向执行](09-model-runner.md)
- 量化模型（FP8 / AWQ / GPTQ）的加载路径 → [第 14 章 高级特性 §模型加载与量化](14-advanced-features.md)
- 怎么给 SGLang 新增一个模型架构 → [第 09 章](09-model-runner.md)、[第 14 章 §模型仓库](14-advanced-features.md)
- 张量并行下权重怎么按 TP rank 切分加载 → [第 13 章 分布式与并行执行](13-distributed.md)

## 8. 走完这一步你脑子里应该多了什么

1. SGLang **不用** HuggingFace 的模型实现跑前向——它在 `srt/models/` 里有**自己的模型骨架**，因为骨架的注意力层要对接分页 KV cache 和可插拔后端。
2. 加载 = 「SGLang 的模型骨架」+「从 HF safetensors 灌进来的权重数值」，靠 `architectures` 字段选骨架、靠 `model_loader` 做命名映射。
3. `load_model` 跑完，权重已在 GPU 显存里；`ModelRunner` 在加载前后测显存，得出权重占用量。
4. 这个「权重占了多少显存」的数字是下一步的输入——KV cache 池的大小由「剩多少显存」决定。
