# 第 6 章：引擎、会话与增量推理

本章描述 DwarfStar 4 推理运行时的核心抽象：`ds4_engine`（已加载的模型）与 `ds4_session`（可变的推理时间线）。重点在于 `ds4_session_sync` 的增量复用逻辑、公共前缀检测与重写决策、CPU 参考路径的结构，以及单实例锁的必要性。

---

## 6.1 ds4_engine 与 ds4_session 的职责划分

`ds4.h:9` 的注释对外部调用者给出了精确的职责定义：

> *The CLI and server should treat `ds4_engine` as the loaded model and `ds4_session` as one mutable inference timeline. A session owns the live KV cache and logits; callers provide full token prefixes and let `ds4_session_sync()` reuse, extend, or rebuild the graph state.*

| 层 | 结构体 | 不变量 |
|----|--------|--------|
| 模型层 | `ds4_engine` | 从 `ds4_engine_open` 返回后不再变化；含权重 mmap、词表、后端句柄 |
| 会话层 | `ds4_session` | 每次 sync/eval 后变化；含 live KV 缓存、当前 checkpoint 令牌向量、logits |

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_engine and ds4_session struct layouts showing read-only model layer versus mutable session layer">
  <defs>
    <marker id="ar61" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="340" height="278" rx="8" fill="#fff8f0" stroke="#ea580c" stroke-width="2"/>
  <rect x="20" y="10" width="340" height="30" rx="8" fill="#ea580c"/>
  <text x="190" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="white">ds4_engine（只读）</text>
  <rect x="38" y="52" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="90" y="66" font-size="11" font-weight="600" fill="currentColor">ds4_model</text>
  <text x="90" y="79" font-size="10" fill="#64748b">GGUF mmap、张量元数据</text>
  <rect x="38" y="90" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="90" y="104" font-size="11" font-weight="600" fill="currentColor">ds4_vocab</text>
  <text x="90" y="117" font-size="10" fill="#64748b">token_to_id / merge_rank 哈希表</text>
  <rect x="38" y="128" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="90" y="142" font-size="11" font-weight="600" fill="currentColor">ds4_weights</text>
  <text x="90" y="155" font-size="10" fill="#64748b">指向 mmap 区域的张量指针</text>
  <rect x="38" y="166" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="90" y="180" font-size="11" font-weight="600" fill="currentColor">ds4_mtp_weights</text>
  <text x="90" y="193" font-size="10" fill="#64748b">MTP 草稿模型（可选）</text>
  <rect x="38" y="204" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="90" y="220" font-size="11" font-weight="600" fill="currentColor">backend / quality / steering</text>
  <text x="90" y="233" font-size="10" fill="#64748b">后端类型、计算精度、方向引导</text>
  <line x1="360" y1="150" x2="398" y2="150" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar61)"/>
  <text x="378" y="145" text-anchor="middle" font-size="9" fill="#94a3b8">共享</text>
  <rect x="400" y="10" width="340" height="278" rx="8" fill="#f0f9ff" stroke="#0d9488" stroke-width="2"/>
  <rect x="400" y="10" width="340" height="30" rx="8" fill="#0d9488"/>
  <text x="570" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="white">ds4_session（可变）</text>
  <rect x="418" y="52" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="470" y="66" font-size="11" font-weight="600" fill="currentColor">ds4_gpu_graph</text>
  <text x="470" y="79" font-size="10" fill="#64748b">Metal/CUDA 图，live KV 缓存（GPU 路径）</text>
  <rect x="418" y="90" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="470" y="104" font-size="11" font-weight="600" fill="currentColor">ds4_kv_cache</text>
  <text x="470" y="117" font-size="10" fill="#64748b">CPU KV 缓存（CPU 路径）</text>
  <rect x="418" y="128" width="306" height="32" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="470" y="142" font-size="11" font-weight="600" fill="currentColor">token_vec checkpoint</text>
  <text x="470" y="155" font-size="10" fill="#64748b">已评估的完整令牌前缀（"真相来源"）</text>
  <rect x="418" y="166" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="470" y="180" font-size="11" font-weight="600" fill="currentColor">float *logits</text>
  <text x="470" y="193" font-size="10" fill="#64748b">最后一步 logit 向量（129280 个 float）</text>
  <rect x="418" y="204" width="306" height="32" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="470" y="220" font-size="11" font-weight="600" fill="currentColor">checkpoint_valid / progress_fn</text>
  <text x="470" y="233" font-size="10" fill="#64748b">有效标志 / 进度回调 / ctx_size / prefill_cap</text>
</svg>
<span class="figure-caption">图 R6.1 ｜ ds4_engine（只读模型层）与 ds4_session（可变会话层）的结构对比</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_engine（只读）
  ├── ds4_model         -- GGUF mmap、张量元数据
  ├── ds4_vocab         -- token_to_id / merge_rank 哈希表
  ├── ds4_weights       -- 指向 mmap 区域的张量指针
  ├── ds4_mtp_weights   -- MTP 草稿模型（可选）
  └── backend / quality / steering

ds4_session（可变）
  ├── ds4_gpu_graph     -- Metal/CUDA 图的 live KV 缓存（GPU 路径）
  ├── ds4_kv_cache      -- CPU KV 缓存（CPU 路径）
  ├── token_vec checkpoint -- 当前已评估的完整令牌前缀
  ├── float *logits     -- 最后一步的 logit 向量（129280 个 float）
  ├── bool checkpoint_valid
  └── progress_fn / ctx_size / prefill_cap
```

</details>

这种分离有三个实际意义：

1. **一个引擎多个会话**：同一引擎可以并发持有多个会话（不同上下文大小、不同用户请求），权重在所有会话间共享。
2. **会话是无状态 API 的桥梁**：HTTP/CLI 层每次请求重发全部令牌，引擎层通过 `ds4_session_sync` 决策是否需要重新计算。
3. **快照持久化边界清晰**：会话序列化仅序列化 live KV 缓存和 checkpoint，不涉及权重。

---

## 6.2 ds4_engine_open：加载流程

```c
// ds4.h:95
int ds4_engine_open(ds4_engine **out, const ds4_engine_options *opt);
```

`ds4_engine_options`（`ds4.h:62`）字段：

| 字段 | 含义 |
|------|------|
| `model_path` | 主模型 GGUF 文件路径 |
| `mtp_path` | MTP（Multi-Token Prediction）草稿模型路径，可为空 |
| `backend` | `DS4_BACKEND_METAL` / `DS4_BACKEND_CUDA` / `DS4_BACKEND_CPU` |
| `n_threads` | CPU 线程数，≤0 表示自动检测 |
| `mtp_draft_tokens` | MTP 草稿步数（1–16），0 表示默认 1 |
| `mtp_margin` | MTP 接受裕度（默认 3.0） |
| `directional_steering_file` | 方向性引导向量文件（可选） |
| `warm_weights` | 是否预热权重页缓存 |
| `quality` | 是否启用高质量（更精确）计算 |

`ds4_engine_open`（`ds4.c:17164`）的加载序列：

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_engine_open load sequence: 10 steps from option validation to MTP weight binding">
  <defs>
    <marker id="ar62" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="720" height="30" rx="5" fill="#ea580c"/>
  <text x="380" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="white">ds4_engine_open() 加载序列</text>
  <rect x="20" y="52" width="50" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="45" y="68" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">1</text>
  <rect x="78" y="52" width="662" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="96" y="68" font-size="11" fill="currentColor">验证选项</text>
  <text x="200" y="68" font-size="10" fill="#64748b">steering 需要文件路径；mtp_draft_tokens 范围检查</text>
  <line x1="380" y1="76" x2="380" y2="84" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar62)"/>
  <rect x="20" y="84" width="50" height="24" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="45" y="100" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">2</text>
  <rect x="78" y="84" width="662" height="24" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="96" y="100" font-size="11" font-weight="600" fill="#dc2626">ds4_acquire_instance_lock()</text>
  <text x="320" y="100" font-size="10" fill="#64748b">单实例锁，防止两个进程同时 mmap 数十 GiB</text>
  <line x1="380" y1="108" x2="380" y2="116" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar62)"/>
  <rect x="20" y="116" width="50" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="45" y="132" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">3</text>
  <rect x="78" y="116" width="662" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="96" y="132" font-size="11" fill="currentColor">model_open()</text>
  <text x="200" y="132" font-size="10" fill="#64748b">mmap GGUF 文件，建立张量元数据索引</text>
  <line x1="380" y1="140" x2="380" y2="148" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar62)"/>
  <rect x="20" y="148" width="50" height="24" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="45" y="164" text-anchor="middle" font-size="11" fill="#94a3b8">4</text>
  <rect x="78" y="148" width="662" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,2"/>
  <text x="96" y="164" font-size="11" fill="#94a3b8">model_warm_weights()  [可选]</text>
  <text x="260" y="164" font-size="10" fill="#94a3b8">顺序预读权重页到内存</text>
  <line x1="380" y1="172" x2="380" y2="180" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar62)"/>
  <rect x="20" y="180" width="50" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="45" y="196" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">5</text>
  <rect x="78" y="180" width="662" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="96" y="196" font-size="11" fill="currentColor">vocab_load()</text>
  <text x="200" y="196" font-size="10" fill="#64748b">从 GGUF 元数据加载词表与合并表，建哈希表</text>
  <line x1="380" y1="204" x2="380" y2="212" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar62)"/>
  <rect x="20" y="212" width="50" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="45" y="228" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">6</text>
  <rect x="78" y="212" width="662" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="96" y="228" font-size="11" fill="currentColor">config_validate_model()</text>
  <text x="260" y="228" font-size="10" fill="#64748b">验证张量形状符合 DS4 固定参数</text>
  <line x1="380" y1="236" x2="380" y2="244" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar62)"/>
  <rect x="20" y="244" width="50" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="45" y="260" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">7</text>
  <rect x="78" y="244" width="662" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="96" y="260" font-size="11" fill="currentColor">weights_bind()</text>
  <text x="200" y="260" font-size="10" fill="#64748b">将 ds4_weights 指针绑定到 mmap 区域</text>
  <line x1="380" y1="268" x2="380" y2="276" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar62)"/>
  <rect x="20" y="276" width="50" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="45" y="292" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">8</text>
  <rect x="78" y="276" width="662" height="24" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
  <text x="96" y="292" font-size="11" fill="currentColor">ds4_gpu_init()  [GPU 路径]</text>
  <text x="240" y="292" font-size="10" fill="#64748b">初始化 Metal/CUDA 设备，分配显存池</text>
  <line x1="380" y1="300" x2="380" y2="308" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar62)"/>
  <rect x="20" y="308" width="50" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="45" y="324" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">9</text>
  <rect x="78" y="308" width="340" height="24" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
  <text x="96" y="324" font-size="11" fill="currentColor">ds4_gpu_set_model_map_range()  [GPU 路径]</text>
  <rect x="426" y="308" width="50" height="24" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="451" y="324" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">10</text>
  <rect x="484" y="308" width="256" height="24" rx="4" fill="#f0fdf4" stroke="#0d9488" stroke-width="1"/>
  <text x="500" y="324" font-size="11" fill="currentColor">mtp_weights_bind()  [MTP]</text>
</svg>
<span class="figure-caption">图 R6.2 ｜ ds4_engine_open 十步加载序列，步骤 2 为单实例锁，8–9 仅 GPU 路径，10 仅 MTP 路径</span>

<details>
<summary>ASCII 原版</summary>

```
1. 验证选项（steering 需要文件路径）
2. ds4_acquire_instance_lock()    -- 单实例锁
3. model_open()                   -- mmap GGUF，建立张量元数据索引
4. model_warm_weights()           -- 可选：顺序读热权重页
5. vocab_load()                   -- 从 GGUF 元数据加载词表和合并表
6. config_validate_model()        -- 验证 GGUF 张量形状符合 DS4 固定参数
7. weights_bind()                 -- 将 ds4_weights 指针绑定到 mmap 区域
8. [GPU 路径] ds4_gpu_init()      -- 初始化 Metal/CUDA 设备
9. [GPU 路径] ds4_gpu_set_model_map_range()  -- 向 GPU 后端注册权重 mmap 范围
10. [MTP] mtp_weights_bind()      -- 绑定草稿模型权重
```

</details>

GGUF 加载的内部细节（`model_open`、`config_validate_model`、`weights_bind`）见 [第 3 章](03-gguf-loading.md)。

`ds4_engine_close`（`ds4.c:17292`）按逆序释放：先 `weights_free`，再 `vocab_free`，再关 MTP 模型，再关主模型，再 GPU 清理，最后释放锁。

---

## 6.3 ds4_session：结构、创建与释放

`ds4_session` 的内部定义（`ds4.c:15715`）：

```c
// ds4.c:15715
struct ds4_session {
    ds4_engine *engine;
#ifndef DS4_NO_GPU
    ds4_gpu_graph graph;      // Metal/CUDA 图，含 live KV 缓存
#endif
    ds4_kv_cache cpu_cache;   // CPU 路径的 KV 缓存
    ds4_cpu_decode_scratch cpu_scratch;  // CPU 解码临时缓冲区
    token_vec checkpoint;     // 已评估的完整令牌前缀（"真相来源"）
    float *logits;            // DS4_N_VOCAB 个 float（129280 个）
    float *mtp_logits;        // MTP 草稿 logits（若有）
    ds4_session_progress_fn progress;
    void *progress_ud;
    uint32_t prefill_cap;     // 分块 prefill 的块大小
    int ctx_size;
    bool checkpoint_valid;
    bool mtp_draft_valid;
};
```

`ds4_session_create`（`ds4.c:17308`）：

```c
// ds4.h:151
int ds4_session_create(ds4_session **out, ds4_engine *e, int ctx_size);
```

CPU 路径：分配 `cpu_cache`（KV 缓存）、`cpu_scratch`（解码临时缓冲）、`logits` 数组。

GPU 路径：调用 `metal_graph_alloc_raw_cap`，在 GPU 侧分配 raw SWA 缓存、压缩 KV 缓存、Indexer 缓存等所有张量（不在 CPU 侧复制权重）。`prefill_cap` 计算（`ds4.c:6184`）：提示长度 ≤ 2048 时等于提示长度，否则默认 2048（可通过 `DS4_METAL_PREFILL_CHUNK` 环境变量覆盖）。

`ds4_session_free`（`ds4.c:17356`）：GPU 路径调用 `metal_graph_free` 释放 GPU 张量，CPU 路径释放 KV 缓存和 scratch，两路均释放 `checkpoint` 向量和 `logits`。

进度回调注册（`ds4.c:17373`）：

```c
// ds4.h:153
void ds4_session_set_progress(ds4_session *s, ds4_session_progress_fn fn, void *ud);
```

`ds4_session_progress_fn` 签名（`ds4.h:60`）：

```c
typedef void (*ds4_session_progress_fn)(void *ud, const char *event,
                                        int current, int total);
```

目前仅有一个 event 字符串：`"prefill_chunk"`，`current` 是已处理令牌数，`total` 是总令牌数。服务器用它向客户端推送进度条（`ds4_server.c`）。

---

## 6.4 ds4_session_sync：增量推理核心

```c
// ds4.h:166
int ds4_session_sync(ds4_session *s, const ds4_tokens *prompt, char *err, size_t errlen);
```

### 6.4.1 决策逻辑

`ds4_session_sync`（`ds4.c:17400`）的注释精确描述了其逻辑：

> *ds4-server and the REPL are stateless at the text/API layer but stateful here: they resend or rebuild the full transcript, and this function decides whether the live checkpoint is a prefix.*

决策流程：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_session_sync decision flowchart showing checkpoint prefix check and three handling paths">
  <defs>
    <marker id="ar63" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="250" y="10" width="260" height="32" rx="6" fill="#ea580c"/>
  <text x="380" y="31" text-anchor="middle" font-size="12" font-weight="700" fill="white">ds4_session_sync(s, prompt)</text>
  <line x1="380" y1="42" x2="380" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <rect x="200" y="62" width="360" height="34" rx="6" fill="#fff8f0" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">checkpoint 有效 AND prompt 以 checkpoint 为前缀？</text>
  <text x="380" y="90" text-anchor="middle" font-size="10" fill="#64748b">suffix = prompt.len − checkpoint.len</text>
  <line x1="200" y1="79" x2="100" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <text x="120" y="115" font-size="10" fill="#16a34a" font-weight="600">是</text>
  <line x1="560" y1="79" x2="660" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <text x="620" y="115" font-size="10" fill="#dc2626" font-weight="600">否</text>
  <rect x="40" y="130" width="200" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="140" y="150" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">suffix == 0</text>
  <rect x="260" y="130" width="200" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="360" y="150" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">suffix ≥ resume_min (32)</text>
  <rect x="480" y="130" width="200" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="580" y="150" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">suffix &lt; resume_min</text>
  <line x1="660" y1="130" x2="700" y2="130" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="700" y1="130" x2="700" y2="155" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <line x1="140" y1="160" x2="140" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <line x1="360" y1="160" x2="360" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <line x1="580" y1="160" x2="580" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <rect x="40" y="200" width="200" height="40" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="140" y="215" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">无需操作</text>
  <text x="140" y="232" text-anchor="middle" font-size="10" fill="#64748b">已是目标状态，直接返回</text>
  <rect x="260" y="200" width="200" height="40" rx="5" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
  <text x="360" y="213" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">metal_graph_prefill_chunked_range</text>
  <text x="360" y="230" text-anchor="middle" font-size="10" fill="#64748b">批量 prefill 后缀（绝对位置对齐）</text>
  <rect x="480" y="200" width="200" height="40" rx="5" fill="#fff8f0" stroke="#ea580c" stroke-width="1"/>
  <text x="580" y="213" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">逐 token decode</text>
  <text x="580" y="230" text-anchor="middle" font-size="10" fill="#64748b">one-token-at-a-time，精确自回归语义</text>
  <rect x="590" y="155" width="220" height="40" rx="5" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="700" y="170" text-anchor="middle" font-size="11" font-weight="600" fill="#dc2626">冷启动 prefill</text>
  <text x="700" y="186" text-anchor="middle" font-size="10" fill="#64748b">丢弃 checkpoint，从 token 0 重建</text>
  <line x1="140" y1="240" x2="140" y2="290" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="240" x2="360" y2="290" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="580" y1="240" x2="580" y2="290" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="700" y1="195" x2="700" y2="290" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="140" y1="290" x2="700" y2="290" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="420" y1="290" x2="420" y2="318" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <rect x="270" y="318" width="300" height="28" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="420" y="337" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">返回 0（成功）；checkpoint 更新为 prompt</text>
  <text x="420" y="368" text-anchor="middle" font-size="10" fill="#94a3b8">非 0 返回表示错误，err 缓冲区填充错误消息</text>
</svg>
<span class="figure-caption">图 R6.3 ｜ ds4_session_sync 决策树：checkpoint 有效时按后缀长度选择增量策略，否则冷启动</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_session_sync(s, prompt)
    │
    ├─ [checkpoint 有效 AND prompt 以 checkpoint 为前缀]
    │       ├─ suffix = prompt.len - checkpoint.len
    │       ├─ suffix == 0：无需操作（已是目标状态）
    │       ├─ suffix >= resume_min (32)
    │       │       └─ GPU: metal_graph_prefill_chunked_range（批量 prefill 后缀）
    │       └─ suffix < resume_min
    │               └─ 逐 token decode（one-token-at-a-time，精确自回归语义）
    │
    └─ [checkpoint 无效 OR prompt 不是前缀]
            ├─ 丢弃 checkpoint
            └─ 从 token 0 冷启动 prefill

返回值：0 = 成功，非 0 = 错误（err 填充消息）
```

</details>

### 6.4.2 两种后缀处理方式

**短后缀（< 32 token）**：每次调用 `metal_graph_eval_token_raw_swa`（一个 token decode 步骤，`ds4.c:17506`），保持精确的自回归语义。小批量不值得启动块 prefill 的对齐开销。

**长后缀（>= 32 token）**：调用 `metal_graph_prefill_chunked_range`（`ds4.c:17485`），从 `checkpoint.len` 位置开始，批量处理后缀。块边界与绝对位置对齐，保证压缩器/Indexer 行以相同顺序敲定——这与冷启动时的顺序一致，避免状态分叉。

阈值 32 可通过 `DS4_METAL_RESUME_PREFILL_MIN` 环境变量覆盖（`ds4.c:13989`）。

### 6.4.3 冷启动 prefill 路径

当 checkpoint 失效或 prompt 不是前缀时，走冷启动（`ds4.c:17521`）：

- 若 `prompt.len > prefill_cap`：使用 `metal_graph_prefill_chunked`（分块，支持超大 prompt）；
- 否则：使用 `metal_graph_prefill_raw_swa`（单次 prefill，更快）。

无论哪种路径，成功后都将 `checkpoint` 替换为整个 `prompt`，设置 `checkpoint_valid = true`。

---

## 6.5 公共前缀复用：rewrite 决策

### 6.5.1 公共前缀计算

```c
// ds4.h:171
int ds4_session_common_prefix(ds4_session *s, const ds4_tokens *prompt);
```

实现（`ds4.c:17611`）：在 `checkpoint` 与 `prompt` 之间找最长公共前缀长度，O(min(checkpoint.len, prompt.len))。若 `checkpoint_valid == false` 则返回 0。

### 6.5.2 重写判断：为什么已采样 token 不能原地重写

```c
// ds4.h:167
bool ds4_session_rewrite_requires_rebuild(int live_len, int canonical_len, int common);
```

实现（`ds4.c:17558`）：

```c
bool ds4_session_rewrite_requires_rebuild(int live_len, int canonical_len, int common) {
    if (live_len < 0 || canonical_len < 0 || common < 0) return true;
    if (common > live_len || common > canonical_len) return true;
    return common < live_len;  // 公共前缀短于 live 长度 → 需要 rebuild
}
```

**关键理由**（`ds4.c:17551` 注释）：

> *A DS4 session checkpoint is more than a token vector: the backend state also contains raw SWA rows, compressed KV rows, indexer rows, and compressor frontiers.*

DS4 的会话状态不只是令牌序列。GPU 状态包含：
- **raw SWA 行**：滑动窗口注意力的未压缩 KV 行（最近 N 行）
- **compressed KV 行**：已提交到压缩 KV 缓存的行
- **Indexer 行**：稀疏注意力的索引结构
- **compressor frontier**：压缩算法的内部状态

若要将 live 尾部替换为不同内容（如工具调用解析后发现生成的 DSML 顺序与规范顺序不同），必须先将 frontier 回滚到重写点，然后重新 prefill。当前实现尚未支持 frontier 快照回滚，因此任何"在 live 末尾之前"的重写都会报告 `REBUILD_NEEDED`（`ds4.c:17601`）。

`ds4_session_rewrite_from_common`（`ds4.c:17574`）：

```c
// ds4.h:168
ds4_session_rewrite_result ds4_session_rewrite_from_common(
        ds4_session *s, const ds4_tokens *prompt, int common,
        char *err, size_t errlen);
```

三种返回值（`ds4.h:155`）：

| 值 | 含义 |
|----|------|
| `DS4_SESSION_REWRITE_OK` | 重写成功（common == live_len，直接 sync 后缀） |
| `DS4_SESSION_REWRITE_REBUILD_NEEDED` | 需要回滚到更旧的 checkpoint（common < live_len） |
| `DS4_SESSION_REWRITE_ERROR` | 参数错误或 checkpoint 无效 |

服务器的处理策略：收到 `REBUILD_NEEDED` 时，查找磁盘 KV 缓存中是否有覆盖公共前缀的旧快照（见 [第 14 章](14-disk-kv-cache.md)），若有则加载后重新 sync；否则从头 prefill。

### 6.5.3 公共前缀复用场景示意

<svg viewBox="0 0 760 310" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Three common-prefix reuse scenarios: append, pure extend, and rebuild-needed">
  <defs>
    <marker id="ar64" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <pattern id="hatch64" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#fca5a5" stroke-width="2"/>
    </pattern>
  </defs>
  <text x="120" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">情形 1：追加（最常见）</text>
  <rect x="20" y="26" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="40" y="42" text-anchor="middle" font-size="10" fill="#0d9488">A</text>
  <rect x="62" y="26" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="82" y="42" text-anchor="middle" font-size="10" fill="#0d9488">B</text>
  <rect x="104" y="26" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="124" y="42" text-anchor="middle" font-size="10" fill="#0d9488">C</text>
  <rect x="146" y="26" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="166" y="42" text-anchor="middle" font-size="10" fill="#0d9488">D</text>
  <text x="200" y="42" font-size="10" fill="#64748b">← checkpoint</text>
  <rect x="20" y="56" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="40" y="72" text-anchor="middle" font-size="10" fill="#0d9488">A</text>
  <rect x="62" y="56" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="82" y="72" text-anchor="middle" font-size="10" fill="#0d9488">B</text>
  <rect x="104" y="56" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="124" y="72" text-anchor="middle" font-size="10" fill="#0d9488">C</text>
  <rect x="146" y="56" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="166" y="72" text-anchor="middle" font-size="10" fill="#0d9488">D</text>
  <rect x="188" y="56" width="40" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="208" y="72" text-anchor="middle" font-size="10" font-weight="700" fill="#ea580c">E</text>
  <rect x="230" y="56" width="40" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="250" y="72" text-anchor="middle" font-size="10" font-weight="700" fill="#ea580c">F</text>
  <text x="285" y="72" font-size="10" fill="#64748b">← new prompt</text>
  <rect x="20" y="86" width="420" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="230" y="101" text-anchor="middle" font-size="10" fill="#16a34a">common=4, live=4 → ds4_session_sync 只处理后缀 [E F]</text>
  <line x1="250" y1="118" x2="730" y2="118" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="380" y="135" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">情形 2：纯扩展（无 rewrite 需要）</text>
  <rect x="20" y="143" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="40" y="159" text-anchor="middle" font-size="10" fill="#0d9488">A</text>
  <rect x="62" y="143" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="82" y="159" text-anchor="middle" font-size="10" fill="#0d9488">B</text>
  <rect x="104" y="143" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="124" y="159" text-anchor="middle" font-size="10" fill="#0d9488">C</text>
  <rect x="146" y="143" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="166" y="159" text-anchor="middle" font-size="10" fill="#0d9488">D</text>
  <text x="200" y="159" font-size="10" fill="#64748b">← checkpoint</text>
  <rect x="20" y="173" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="40" y="189" text-anchor="middle" font-size="10" fill="#0d9488">A</text>
  <rect x="62" y="173" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="82" y="189" text-anchor="middle" font-size="10" fill="#0d9488">B</text>
  <rect x="104" y="173" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="124" y="189" text-anchor="middle" font-size="10" fill="#0d9488">C</text>
  <rect x="146" y="173" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="166" y="189" text-anchor="middle" font-size="10" fill="#0d9488">D</text>
  <rect x="188" y="173" width="40" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="208" y="189" text-anchor="middle" font-size="10" font-weight="700" fill="#ea580c">E</text>
  <rect x="230" y="173" width="40" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="250" y="189" text-anchor="middle" font-size="10" font-weight="700" fill="#ea580c">F</text>
  <text x="285" y="189" font-size="10" fill="#64748b">← canonical（工具调用后规范化）</text>
  <rect x="20" y="203" width="450" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="245" y="218" text-anchor="middle" font-size="10" fill="#16a34a">common=4 == live=4 → ds4_session_rewrite_from_common → REWRITE_OK</text>
  <line x1="20" y1="235" x2="500" y2="235" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="260" y="252" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">情形 3：需要 rebuild（DSML 顺序不同）</text>
  <rect x="20" y="260" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="40" y="276" text-anchor="middle" font-size="10" fill="#0d9488">A</text>
  <rect x="62" y="260" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="82" y="276" text-anchor="middle" font-size="10" fill="#0d9488">B</text>
  <rect x="104" y="260" width="40" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="124" y="276" text-anchor="middle" font-size="10" fill="#0d9488">C</text>
  <rect x="146" y="260" width="40" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="166" y="276" text-anchor="middle" font-size="10" font-weight="700" fill="#7c3aed">X</text>
  <rect x="188" y="260" width="40" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="208" y="276" text-anchor="middle" font-size="10" font-weight="700" fill="#7c3aed">Y</text>
  <text x="240" y="276" font-size="10" fill="#64748b">← checkpoint（live 已采样）</text>
  <rect x="20" y="286" width="120" height="20" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="80" y="300" text-anchor="middle" font-size="9" fill="#64748b">A B C（共同前缀）</text>
  <rect x="146" y="286" width="40" height="20" rx="3" fill="url(#hatch64)" stroke="#dc2626" stroke-width="1.5"/>
  <text x="166" y="300" text-anchor="middle" font-size="9" fill="#dc2626">X'</text>
  <rect x="188" y="286" width="40" height="20" rx="3" fill="url(#hatch64)" stroke="#dc2626" stroke-width="1.5"/>
  <text x="208" y="300" text-anchor="middle" font-size="9" fill="#dc2626">Y'</text>
  <text x="240" y="299" font-size="10" fill="#64748b">← canonical (X'≠X)</text>
  <rect x="440" y="260" width="310" height="46" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="595" y="278" text-anchor="middle" font-size="11" font-weight="600" fill="#dc2626">common=3 &lt; live=5 → REBUILD_NEEDED</text>
  <text x="595" y="297" text-anchor="middle" font-size="10" fill="#64748b">frontier 需回滚，当前实现必须重建</text>
</svg>
<span class="figure-caption">图 R6.4 ｜ 公共前缀复用三种情形：追加（直接 sync）、纯扩展（REWRITE_OK）、分叉（REBUILD_NEEDED）</span>

<details>
<summary>ASCII 原版</summary>

```
情形 1：追加（最常见）
  checkpoint: [A B C D]
  new prompt:  [A B C D E F]
  common=4, live=4 → ds4_session_sync 只处理后缀 [E F]

情形 2：纯扩展（无 rewrite 需要）
  checkpoint: [A B C D]
  canonical:   [A B C D E F]   （工具调用后规范化版本）
  common=4 == live=4 → ds4_session_rewrite_from_common → REWRITE_OK

情形 3：需要 rebuild（工具调用 DSML 顺序不同）
  checkpoint: [A B C X Y]     （live 包含已采样的 X Y）
  canonical:   [A B C X' Y']  （规范版本中 X'≠X 或 Y'≠Y）
  common=4 < live=5 → REBUILD_NEEDED
```

</details>

---

## 6.6 CPU 参考路径

CPU 路径是正确性参考实现，不是生产路径。其存在价值在于：GPU 后端的数值精度可与 CPU 浮点路径逐层比对，发现量化误差或算子实现错误（见 `ds4.c:14101`，GPU/CPU 对比测试）。

### 6.6.1 持久 CPU 线程池

`ds4_threads_init`（`ds4.c:678`）在第一次 CPU 计算时惰性初始化：

```c
// ds4.c:676
/* Create the persistent CPU worker pool.  Decode reuses these threads
 * instead of creating pthreads in the token loop. */
static void ds4_threads_init(void) {
    if (g_pool.initialized) return;
    uint32_t n_threads = 12;
    const long online_cpus = sysconf(_SC_NPROCESSORS_ONLN);
    if (online_cpus > 0) {
        n_threads = online_cpus < 12 ? (uint32_t)online_cpus : 12;
    }
    // 可通过 DS4_THREADS 或 ds4_engine_options.n_threads 覆盖
    // ...
    for (uint32_t i = 1; i < n_threads; i++) {
        pthread_create(&g_pool.threads[i], NULL, ds4_worker_main, ...);
    }
}
```

线程数上限 12，自动检测在线 CPU 数。Worker 线程通过条件变量等待任务，decode 循环复用同一批线程（不每次创建/销毁），避免 per-token 线程开销。`ds4_parallel_for_min_rows`（`ds4.c:736`）实现行并行：若行数 < 阈值或当前在嵌套并行中则降级为串行。

### 6.6.2 CPU decode 单 token：forward_token_raw_swa_cpu_decode_scratch

```c
// ds4.c:7701（精简）
/* CPU decode for one token through all 43 layers.
 * The caller owns scratch and cache lifetimes so no per-token allocations
 * are needed. */
static void forward_token_raw_swa_cpu_decode_scratch(
        float *logits, const ds4_model *model, const ds4_weights *weights,
        ds4_kv_cache *cache, int token, uint32_t pos,
        const float *steering_dirs, float steering_attn_scale,
        float steering_ffn_scale,
        ds4_cpu_decode_scratch *scratch) {
    float *cur = scratch->cur;
    float *next = scratch->next;
    embed_token_f16(model, weights, token, scratch->plain);
    hc_from_plain_embedding(cur, scratch->plain, DS4_N_EMBD, DS4_N_HC);
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        layer_forward_raw_swa_one(next, model, &weights->layer[il],
                                  &cache->layer[il], cur, il, pos, token,
                                  steering_dirs, steering_attn_scale,
                                  steering_ffn_scale, scratch);
        float *tmp = cur; cur = next; next = tmp;  // 原地交换缓冲区
    }
    if (logits) output_logits_one_decode_scratch(logits, model, weights, cur, scratch);
}
```

43 层依次执行（`DS4_N_LAYER = 43`，`ds4.c:87`），`cur`/`next` 双缓冲交换，无额外分配。

### 6.6.3 CPU prefill：layer-major 顺序

`prefill_layer_major_cpu`（`ds4.c:7761`）：

```c
// ds4.c:7761
/* CPU prefill in layer-major order.  All prompt tokens pass through layer 0,
 * then layer 1, etc., which exposes batch matmul opportunities. */
static void prefill_layer_major_cpu(...) {
    for (uint64_t t = 0; t < n_tok; t++) {
        embed_token_f16(model, weights, prompt->v[t], plain);
        hc_from_plain_embedding(cur + t * hc_dim, plain, DS4_N_EMBD, DS4_N_HC);
    }
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        fprintf(stderr, "ds4: prefill layer %u/%u\r", il + 1, DS4_N_LAYER);
        layer_attention_raw_swa_batch(...);  // 整个 prompt 批量注意力
        // FFN：batched_ffn / shared_batch_ffn / 逐 token
        ...
        float *tmp = cur; cur = next; next = tmp;
    }
}
```

Layer-major 顺序（先所有 token 过 layer 0，再所有 token 过 layer 1，…）而不是 token-major 顺序，目的是让同一层的所有 token 在同一次批量矩阵乘法中处理，充分利用 CPU SIMD 宽度。这与 GPU 路径的 Flash Attention 分块策略等价，但实现在 CPU 侧。

### 6.6.4 CPU 生成入口

`generate_raw_swa_cpu`（`ds4.c:15331`）：

```c
// ds4.c:15331
/* CPU generation entry point.  It runs layer-major prefill once, then decodes
 * one token at a time using the persistent KV cache and scratch arena. */
static int generate_raw_swa_cpu(...) {
    fprintf(stderr, "ds4: using CPU generation with layer-major prefill\n");
    kv_cache_init(&cache, (uint32_t)ctx_size, 0);
    cpu_decode_scratch_init(&decode_scratch, (uint32_t)ctx_size);
    // 1. 一次性 layer-major prefill
    prefill_layer_major_cpu(logits, model, weights, &cache, prompt, ...);
    // 2. argmax 采样 + 逐 token decode
    for (int i = 0; i < n_predict && pos < ctx_size; i++) {
        int token = sample_argmax(logits, DS4_N_VOCAB);
        if (token == vocab->eos_id) break;
        emit(emit_ud, token);
        forward_token_raw_swa_cpu_decode_scratch(logits, model, weights, &cache,
                                                 token, pos, ..., &decode_scratch);
        pos++;
    }
}
```

CPU 路径使用 argmax 而非温度采样——这是正确性测试基准。生产路径（Metal/CUDA）通过 `ds4_session_sample` 支持温度、top-p、min-p 采样。

---

## 6.7 单实例锁

### 6.7.1 机制

`ds4_acquire_instance_lock`（`ds4.c:15671`）在 `ds4_engine_open` 的最早阶段调用：

```c
// ds4.c:15669
/* Refuse to start a second ds4 process.  The model can map tens of GiB,
 * so a stale accidental second run is more dangerous than a normal CLI error. */
static void ds4_acquire_instance_lock(void) {
    const char *path = getenv("DS4_LOCK_FILE");
    if (!path || !path[0]) path = "/tmp/ds4.lock";
    const int fd = open(path, O_RDWR | O_CREAT, 0600);
    // ...
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        if (errno == EWOULDBLOCK) {
            // 读取锁文件中存储的 PID，输出有意义的错误消息
            fprintf(stderr, "ds4: another ds4 process is already running (pid %ld);"
                            " refusing to start\n", owner);
            exit(2);
        }
    }
    dprintf(fd, "%ld\n", (long)getpid());  // 写入当前 PID
    g_ds4_lock_fd = fd;
    atexit(ds4_release_instance_lock);     // 正常退出时自动释放
}
```

锁文件默认路径 `/tmp/ds4.lock`，可通过 `DS4_LOCK_FILE` 环境变量覆盖（容器化部署多实例时使用）。

### 6.7.2 为什么需要单实例锁

注释 `ds4.c:15669` 给出了直接原因：**模型可能 mmap 数十 GiB**。具体风险：

1. **内存/显存压力**：DeepSeek V4 Flash 的全精度权重约 130B 参数；即使量化，单个实例也可能消耗 20–80 GiB GPU 内存。两个实例并发会导致 GPU OOM 或 CPU 页面抖动。
2. **Metal/CUDA 资源竞争**：GPU 后端在初始化时独占设备内存池的大块分配（`ds4_gpu_init`）。Metal 在 `macOS` 上的统一内存架构中，两个进程的大型 MTLBuffer 竞争可能导致静默失败而不是明确报错。
3. **意外启动比崩溃更危险**：用户误开第二个终端窗口时，宁愿立即得到清晰的错误（"pid 12345 already running"），也不希望两个实例在后台各自消耗资源、互相干扰推理结果。

`flock(LOCK_EX | LOCK_NB)` 是非阻塞独占锁：若锁被持有则立即返回 `EWOULDBLOCK`，不挂起进程。锁在 `ds4_engine_close` 中显式释放（`ds4.c:17302`），也通过 `atexit` 注册（`ds4.c:15712`）确保异常退出时释放。

---

## 6.8 会话生命周期：关键操作速查

```c
// ds4.h：会话操作 API 概览
int    ds4_session_create(ds4_session **out, ds4_engine *e, int ctx_size);
void   ds4_session_free(ds4_session *s);
void   ds4_session_set_progress(ds4_session *s, ds4_session_progress_fn fn, void *ud);

// 同步：核心操作
int    ds4_session_sync(ds4_session *s, const ds4_tokens *prompt, char *err, size_t errlen);
int    ds4_session_eval(ds4_session *s, int token, char *err, size_t errlen);

// 重写决策
int    ds4_session_common_prefix(ds4_session *s, const ds4_tokens *prompt);
bool   ds4_session_rewrite_requires_rebuild(int live, int canonical, int common);
ds4_session_rewrite_result ds4_session_rewrite_from_common(
           ds4_session *s, const ds4_tokens *prompt, int common,
           char *err, size_t errlen);

// 采样
int    ds4_session_argmax(ds4_session *s);
int    ds4_session_sample(ds4_session *s, float temperature, int top_k,
                          float top_p, float min_p, uint64_t *rng);
int    ds4_session_top_logprobs(ds4_session *s, ds4_token_score *out, int k);

// 状态查询与修改
int    ds4_session_pos(ds4_session *s);           // == checkpoint.len
int    ds4_session_ctx(ds4_session *s);           // ctx_size
void   ds4_session_invalidate(ds4_session *s);   // 清空 checkpoint
void   ds4_session_rewind(ds4_session *s, int pos); // 截断 checkpoint
const ds4_tokens *ds4_session_tokens(ds4_session *s); // 当前 checkpoint
```

`ds4_session_invalidate`（`ds4.c:18384`）：置 `checkpoint_valid = false`、清空 `checkpoint`、清除 MTP 草稿。下次 sync 将从头 prefill。

`ds4_session_rewind`（`ds4.c:18390`）：截断 checkpoint 到指定长度，但**不触碰 GPU 状态**——它只更新令牌向量，GPU 中对应位置的 raw/compressed KV 行仍然有效。这允许服务器在采样到 EOS 后退一步、注入额外 token 而无需完整 prefill。

---

## 6.9 磁盘 KV 缓存持久化（简述）

`ds4_session` 提供序列化/反序列化接口（`ds4.h:193`）：

```c
uint64_t ds4_session_payload_bytes(ds4_session *s);
int ds4_session_save_payload(ds4_session *s, FILE *fp, char *err, size_t errlen);
int ds4_session_load_payload(ds4_session *s, FILE *fp, uint64_t payload_bytes,
                             char *err, size_t errlen);
```

Payload 格式（`ds4.c:15757`）：固定魔数 `0x34565344`（"DSV4"）+ 版本号 + 形状字段，然后是 checkpoint 令牌、最后 logits、每层压缩行数、raw SWA 行（仅最后逻辑窗口）、compressed KV 行、compressor/indexer frontier。服务端（`ds4_server.c`）拥有文件头和缓存策略，引擎拥有 payload 内容。详见 [第 14 章](14-disk-kv-cache.md)。

---

## 6.10 增量推理流程：端到端示意

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="End-to-end incremental inference flow from user request through session sync to generation loop">
  <defs>
    <marker id="ar65" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="230" y="10" width="300" height="30" rx="6" fill="#ea580c"/>
  <text x="380" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="white">用户请求（完整对话历史）</text>
  <line x1="380" y1="40" x2="380" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
  <rect x="180" y="58" width="400" height="36" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="72" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ds4_encode_chat_prompt / ds4_chat_append_message</text>
  <text x="380" y="86" text-anchor="middle" font-size="10" fill="#64748b">→ ds4_tokens prompt（参见第 5 章）</text>
  <line x1="380" y1="94" x2="380" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
  <rect x="210" y="112" width="340" height="30" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="126" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ds4_session_common_prefix(s, &amp;prompt)</text>
  <text x="380" y="140" text-anchor="middle" font-size="10" fill="#64748b">→ common（公共前缀长度）</text>
  <line x1="380" y1="142" x2="380" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
  <rect x="180" y="160" width="400" height="30" rx="5" fill="#fff8f0" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="179" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">common 与 checkpoint / prompt 的关系？</text>
  <line x1="180" y1="175" x2="80" y2="215" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
  <text x="95" y="205" font-size="9" fill="#16a34a">== prompt.len</text>
  <line x1="380" y1="190" x2="380" y2="215" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
  <text x="340" y="210" font-size="9" fill="#0d9488">== checkpoint.len</text>
  <line x1="580" y1="175" x2="670" y2="215" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
  <text x="640" y="205" font-size="9" fill="#dc2626">&lt; checkpoint.len</text>
  <rect x="20" y="215" width="180" height="40" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="110" y="230" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">直接读 logits</text>
  <text x="110" y="246" text-anchor="middle" font-size="10" fill="#64748b">已是目标状态</text>
  <rect x="250" y="215" width="260" height="40" rx="5" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="230" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">ds4_session_sync(s, &amp;prompt)</text>
  <text x="380" y="246" text-anchor="middle" font-size="10" fill="#64748b">只处理后缀（增量 prefill）</text>
  <rect x="560" y="215" width="190" height="40" rx="5" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="655" y="230" text-anchor="middle" font-size="11" font-weight="600" fill="#dc2626">rewrite_from_common</text>
  <text x="655" y="246" text-anchor="middle" font-size="10" fill="#64748b">→ REBUILD_NEEDED?</text>
  <line x1="655" y1="255" x2="655" y2="275" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar65)"/>
  <rect x="530" y="275" width="110" height="38" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="585" y="289" text-anchor="middle" font-size="10" font-weight="600" fill="#16a34a">有磁盘快照</text>
  <text x="585" y="304" text-anchor="middle" font-size="9" fill="#64748b">load_payload → sync</text>
  <rect x="650" y="275" width="110" height="38" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="705" y="289" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">无快照</text>
  <text x="705" y="304" text-anchor="middle" font-size="9" fill="#64748b">invalidate → 冷启动</text>
  <line x1="110" y1="255" x2="110" y2="330" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="380" y1="255" x2="380" y2="330" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="585" y1="313" x2="585" y2="330" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="705" y1="313" x2="705" y2="330" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="110" y1="330" x2="705" y2="330" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="407" y1="330" x2="407" y2="352" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
  <rect x="170" y="352" width="474" height="90" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="407" y="370" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">生成循环</text>
  <rect x="190" y="378" width="430" height="22" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="405" y="393" text-anchor="middle" font-size="10" fill="currentColor">token = ds4_session_sample(s, temperature, top_k, top_p, min_p, rng)</text>
  <rect x="190" y="406" width="430" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="405" y="421" text-anchor="middle" font-size="10" fill="#64748b">ds4_session_eval(s, token)   ← 追加一步 decode</text>
  <text x="407" y="445" text-anchor="middle" font-size="10" fill="#94a3b8">重复直到 EOS 或长度限制</text>
</svg>
<span class="figure-caption">图 R6.5 ｜ 端到端增量推理流程：公共前缀检测决定走直接读 logits、增量 sync 还是冷启动三条路径</span>

<details>
<summary>ASCII 原版</summary>

```
用户请求（完整对话历史）
    │
    ▼ ds4_encode_chat_prompt / ds4_chat_append_message
    │   → ds4_tokens prompt（参见第 5 章）
    │
    ▼ ds4_session_common_prefix(s, &prompt)
    │   → common
    │
    ├─ [common == prompt.len] → 直接读 logits（已是目标状态）
    │
    ├─ [common == s->checkpoint.len]
    │       → ds4_session_sync(s, &prompt) → 只处理后缀
    │
    └─ [common < s->checkpoint.len]
            → ds4_session_rewrite_from_common → REBUILD_NEEDED?
                    ├─ 有磁盘快照：load_payload → ds4_session_sync
                    └─ 无快照：ds4_session_invalidate → ds4_session_sync（冷启动）
    │
    ▼ 生成循环
    │   token = ds4_session_sample(s, temperature, ...)
    │   ds4_session_eval(s, token)     （追加一步 decode）
    │   重复直到 EOS 或长度限制
```

</details>

---

## 6.11 相关章节

- 令牌序列的构造（BPE 分词、对话模板）见 [第 5 章](05-tokenizer-chat.md)
- GGUF 模型加载与权重绑定见 [第 3 章](03-gguf-loading.md)
- Metal/CUDA 图的 prefill 和 decode 实现见 [第 10 章](10-metal-backend.md)
- KV 缓存压缩与稀疏注意力见 [第 7 章](07-kv-cache.md)
- MTP（Multi-Token Prediction）草稿模型见 [第 12 章](12-speculative-mtp.md)
- 磁盘 KV 缓存持久化协议见 [第 14 章](14-disk-kv-cache.md)
