# Trace 步骤 03 —— mmap 给你一堆字节，怎么确认它真是 DS4 模型？

## 1. 当前情境

步骤 02 结束后，`ds4_model` 已经就绪：

```
m->map            = 指向 DS4.gguf 起点的 mmap 指针
m->n_kv           = 元数据键值对数量（~数百条）
m->n_tensors      = 张量数量（~数千个）
m->kv[]           = 元数据索引，每条记录键名 + 值在 mmap 的偏移
m->tensors[]      = 张量目录，每条记录名字 + 类型 + 维度 + abs_offset
```

但此刻程序还不知道这份 mmap 对应的是不是 DeepSeek V4 Flash。GGUF 格式本身是通用
容器——同一格式可以存 LLaMA、Mistral、任意其他架构。文件头的魔数和版本号已在步骤
02 验过（`ds4.c:1231–1236`），但那只能证明「这是一个合法的 GGUF v3 文件」，
不能证明「里面的权重形状符合 DS4 Flash 的硬编码推理管线」。

接下来 `model_open()` 返回，调用者依次执行：

1. `weights_bind()` —— 把张量名绑定进固定的 43 层布局指针（`ds4.c:2648`）
2. `weights_validate_layout()` —— 校验每个张量的类型和维度（`ds4.c:2355`）
3. `config_validate_model()` —— 校验影响语义的元数据（`ds4.c:2562`）

这三步全部通过，才算确认「这个文件真的是 DS4 Flash」。

## 2. 问题

这一步要回答：**如果有人把一个 LLaMA-3 的 GGUF 塞进来，程序应该在什么时候、
以什么方式拒绝？** 具体矛盾有三层：

1. **张量名层**：GGUF 目录里的张量名字是字符串，推理代码里的指针是 C 语言固定偏移。
   如果名字对不上，指针就是野指针。
2. **张量形状层**：即使名字对上了，如果维度不匹配，Metal shader 会按错误的内存布局
   读权重，输出的是噪声而不是错误信息。
3. **语义元数据层**：RoPE 频率、专家数、HC 数等超参数一旦和推理代码里的硬编码常数
   不一致，计算是「跑通但结果错」的——比 crash 更危险，因为你不知道输出是错的。

## 3. 朴素思路

在推理代码里，每次用到张量时动态查一次名字、再检查维度。比如注意力子层里：

```c
// 直觉方案：每次用时查找并检查
const ds4_tensor *q_a = model_find_tensor(m, "blk.0.attn_q_a.weight");
if (!q_a) { ... }
if (q_a->dim[0] != DS4_N_EMBD) { ... }
```

检查是做了，问题在于时机和成本。

## 4. 为什么朴素思路会崩

- **性能**：43 层 × 每层 20+ 个张量 = 860+ 次字符串查找。如果放在推理热路径里，
  每次前向传播都要扫描一遍张量目录（`m->n_tensors` 通常超过 800），
  光名字比较就要浪费可见的推理时间。
- **错误延迟**：问题只在第一次用到那个张量时才暴露。如果是第 30 层的某个专家权重
  维度错了，程序跑到第 30 层才崩，堆栈信息在推理内核深处，极难定位。
- **部分绑定的安全性**：如果绑定和校验是分散在各个调用点的，很容易漏掉某个张量。
  一个未被检验的张量指针就是一个潜在的越界读。

## 5. DwarfStar 4 的做法

DwarfStar 4 把绑定和校验从推理热路径里**完全剥离**，在启动阶段一次性做完。
整个过程分三个函数，按顺序调用：

<svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-stage validation pipeline: weights_bind binds tensor name strings to fixed pointers, weights_validate_layout checks type and dimensions, config_validate_model checks semantic metadata">
  <defs>
    <marker id="ar-t3-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar-t3-1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/>
    </marker>
  </defs>
  <rect x="140" y="10" width="360" height="72" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="30" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">weights_bind()</text>
  <text x="320" y="47" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:2648</text>
  <text x="320" y="61" font-size="10" fill="#64748b" text-anchor="middle">张量名字符串 → ds4_layer_weights 固定指针</text>
  <text x="320" y="75" font-size="10" fill="#64748b" text-anchor="middle">43 层 × ~20 个指针，required_tensorf() 找不到即 exit(1)</text>
  <line x1="320" y1="82" x2="320" y2="102" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-t3-1)"/>
  <rect x="140" y="102" width="360" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="122" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">weights_validate_layout()</text>
  <text x="320" y="139" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:2355</text>
  <text x="320" y="155" font-size="10" fill="#64748b" text-anchor="middle">对每个指针：tensor_expect_layout(t, type, ndim, d0, d1)</text>
  <text x="320" y="171" font-size="10" fill="#64748b" text-anchor="middle">类型错 / 维度错 → stderr + exit(1)</text>
  <line x1="460" y1="142" x2="530" y2="142" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar-t3-1r)"/>
  <text x="535" y="138" font-size="10" fill="#dc2626">exit(1)</text>
  <line x1="320" y1="182" x2="320" y2="202" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-t3-1)"/>
  <rect x="140" y="202" width="360" height="96" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="222" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">config_validate_model()</text>
  <text x="320" y="239" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:2562</text>
  <text x="320" y="255" font-size="10" fill="#64748b" text-anchor="middle">从 m-&gt;kv 读出所有语义元数据</text>
  <text x="320" y="271" font-size="10" fill="#64748b" text-anchor="middle">逐一对照编译期常数（DS4_N_* / DS4_ROPE_* 等）</text>
  <text x="320" y="287" font-size="10" fill="#64748b" text-anchor="middle">任何一条不符 → stderr + exit(1)</text>
  <line x1="460" y1="255" x2="530" y2="255" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar-t3-1r)"/>
  <text x="535" y="251" font-size="10" fill="#dc2626">exit(1)</text>
  <line x1="320" y1="298" x2="320" y2="318" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-t3-1)"/>
  <rect x="180" y="318" width="280" height="40" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="320" y="336" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">三关全过 → 进入推理</text>
  <text x="320" y="352" font-size="10" fill="#16a34a" text-anchor="middle">权重已绑定，超参数已确认，热路径无字符串查找</text>
  <text x="320" y="385" font-size="10" fill="#94a3b8" text-anchor="middle">虚线红箭头 = 任一不符立即终止</text>
</svg>
<span class="figure-caption">图 T3.1 ｜ 三阶段校验管线：绑定指针 → 类型/维度校验 → 语义元数据校验，任一失败即 exit(1)</span>

<details>
<summary>ASCII 原版</summary>

```
weights_bind()                       ds4.c:2648
    │
    │  把张量名字符串 → ds4_layer_weights 里的固定指针
    │  43 层 × 每层约 20 个指针全部填好
    │  最后调用 weights_validate_layout()
    │
    ▼
weights_validate_layout()            ds4.c:2355
    │
    │  对每一个指针：tensor_expect_layout(t, type, ndim, d0, d1, d2)
    │  类型错 → stderr + exit(1)
    │  维度错 → stderr + exit(1)
    │
    ▼
config_validate_model()              ds4.c:2562
    │
    │  从 m->kv 读出所有影响推理语义的元数据
    │  逐一对照编译期常数（DS4_N_*）
    │  任何一条不符 → stderr + exit(1)
```

</details>

**`weights_bind()`** 只做一件事：把字符串查找的结果存进指针。以层 0 的注意力 Q
投影为例：

```c
l->attn_q_a = required_tensorf(m, "blk.%u.attn_q_a.weight", il);
// ds4.c:2667
```

`required_tensorf()` 在张量目录里找名字，找不到就 `exit(1)`。找到就返回
`ds4_tensor *`，存进 `ds4_layer_weights`。绑定完成后，推理代码永远只通过这个固定
指针访问张量——不再有字符串查找。

**`weights_validate_layout()`** 对 `ds4_layer_weights` 里的每个指针调用
`tensor_expect_layout()`（`ds4.c:2226`），检查：

- `t->type`：是否是期望的量化类型（比如 `attn_q_a` 必须是 `Q8_0`）
- `t->ndim`：是否是期望的维数（2 维 = 矩阵，1 维 = 向量）
- `t->dim[0]`, `t->dim[1]`：是否精确匹配（比如 `attn_q_a` 必须是 `DS4_N_EMBD × DS4_N_LORA_Q`）

一张典型的矩阵校验：

```c
// ds4.c:2378
tensor_expect_layout(l->attn_q_a,
    DS4_TENSOR_Q8_0, 2,
    DS4_N_EMBD,    // dim[0] = 4096
    DS4_N_LORA_Q,  // dim[1] = 1024
    0);
```

专家权重走单独的 `tensor_expect_routed_expert()`（`ds4.c:2316`），额外验证量化类型
必须是 `IQ2_XXS`、`Q2_K`、`Q4_K` 之一（这些是 DwarfStar 4 支持的路由专家量化格式）。

**`config_validate_model()`** 从元数据里取出每个影响语义的超参数，逐一和编译期常数
对照。以 HC 数为例：

```c
// ds4.c:2611-2612
const uint32_t n_hc = required_u32(m, "deepseek4.hyper_connection.count");
config_expect_u32("hyper_connection.count", n_hc, DS4_N_HC);  // 必须等于 4
```

完整校验列表包括：嵌入维度（4096）、词表大小（129280）、注意力头数（64）、
KV 头数、头维度、RoPE 旋转维度、LoRA rank、专家数（256）、激活专家数（6）、
共享专家数（1）、哈希路由层数（3）、SWA 窗口（128）、indexer 参数、HC 参数、
RoPE 频率基底、YaRN 参数、压缩率元数据、SwiGLU 截断值、专家权重归一化标志。

任何一条不符，`config_expect_u32()` / `config_expect_f32()` 把具体数值打印到
`stderr` 再 `exit(1)`——程序在推理开始之前就终止，而不是带着错误的超参数运行。

## 6. 代码位置

按阅读顺序：

- `ds4.c:2226`：`tensor_expect_layout()`，校验类型 + 维数 + 每维大小的核心函数。
- `ds4.c:2316`：`tensor_expect_routed_expert()`，专家张量的类型约束（允许多种量化格式）。
- `ds4.c:2355`：`weights_validate_layout()`，对所有绑定指针逐一调用 `tensor_expect_layout()`；
  全局张量（`token_embd`、`output`、`output_norm` 等）在循环外先验，层张量在 43 层循环内验。
- `ds4.c:2419`：`ffn_gate_exps` 和 `ffn_up_exps` 的量化类型一致性检查（两者必须相同）。
- `ds4.c:2543`：`config_expect_f32()`，浮点超参数比对（用相对误差 1e-6，容忍 IEEE 754 舍入）。
- `ds4.c:2562`：`config_validate_model()`，语义元数据校验入口，读取并比对所有超参数。
- `ds4.c:2648`：`weights_bind()`，把 GGUF 张量名字符串一次性绑定成固定指针；最后调用 `weights_validate_layout()`。
- `ds4.c:2707`：`weights_bind()` 的最后一行 `weights_validate_layout(w)`，校验紧跟绑定。

## 7. 分支与延伸

- DS4 Flash 的完整层布局（`ds4_weights` / `ds4_layer_weights` 的所有字段、
  压缩率分配、哈希路由层与偏置 top-k 层的区别）→
  [第 2 章 模型结构](02-model-architecture.md)
- GGUF 张量目录的二进制布局、`required_tensorf()` 的实现、
  `tensor_by_namef()` 的可选语义（`ffn_exp_probs_b` 是可选偏置张量）→
  [第 3 章 GGUF 加载](03-gguf-loading.md)
- 各量化类型（`Q8_0`、`IQ2_XXS`、`Q2_K`、`Q4_K`）的块结构、字节数计算、
  以及为什么路由专家用更激进的低比特量化→
  [第 4 章 量化](04-quantization.md)
- MTP draft 权重（`mtp_weights_bind()`，`ds4.c:2710`）走类似的绑定 + 校验流程，
  但那是推测解码路径，本 trace 不涉及 →
  [第 2 章 模型结构](02-model-architecture.md)

## 8. 走完这一步你脑子里应该多了什么

1. **绑定和校验从热路径里完全剥离**：推理代码里的所有权重访问都通过启动阶段填好的
   固定指针（`l->attn_q_a`、`l->ffn_gate_exps`…），不再有字符串查找——这是
   ds4 单文件 C 代码能保持低延迟的基础之一。
2. **三级防线**：GGUF 格式合法性（魔数/版本，步骤 02），张量类型 + 维度（`weights_validate_layout`），
   语义超参数（`config_validate_model`）——三层都过了才进入推理，不会带病运行。
3. **错误在加载阶段以明确消息终止**：`tensor_expect_layout()` 和 `config_expect_u32()`
   都把期望值和实际值一起打印出来，再 `exit(1)`。调试一个形状不符的模型文件，
   不需要去 gdb 推理内核深处，stderr 第一行就能看到问题在哪个张量的哪个维度。
4. **专家权重的量化类型是「多选一」而非固定**：`tensor_expect_routed_expert()` 接受
   `IQ2_XXS` / `Q2_K` / `Q4_K` 三种，允许同一模型架构使用不同精度的专家量化文件，
   而注意力矩阵（`Q8_0`）和 HC 矩阵（`F16`）则精确锁定。
5. **浮点超参数用相对误差比对，不做精确相等**：`config_expect_f32()` 用 `fabsf` +
   `1e-6` 的相对容忍度，因为不同工具链序列化同一 `float` 可能有末位差异；
   整数超参数则要求精确相等。
