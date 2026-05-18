# Trace 步骤 04 —— 一堆带名字的张量,怎么变成"知道自己是 Qwen2.5"的模型?

## 1. 当前情境

步骤 02-03 完成之后,内存里已经有:

- `llama_model_loader ml`:持有 `gguf_context *`(全部元数据 KV)和 `weights_map`(张量名→文件偏移)。
- 每个 `ggml_tensor->data` 都已指向有效地址(CPU 层指向 mmap 区,GPU 层指向设备内存)。

但 `llama_model` 对象本身此刻仍不完整:`arch` 字段还是 `LLM_ARCH_UNKNOWN`(除非 loader 构造时已初步设置),`hparams` 的大多数字段都是零值,`layers[]` 数组还没有被正确填充。

`llama_model_load`(`src/llama.cpp:276`)在构造好 loader 之后,按顺序调用了这几个方法:

```
llama_model_create(ml, params)   -> src/llama.cpp:283   根据 arch 枚举实例化正确的模型子类
model->load_hparams(ml)          -> src/llama.cpp:306   填充 llama_hparams
model->load_vocab(ml)            -> src/llama.cpp:314   填充 llama_vocab
model->load_tensors(ml)          -> src/llama.cpp:327   创建并加载所有权重张量
```

本步覆盖上面全部四个调用——它们共同把"一堆带名字的张量"变成一个架构明确、超参完整、张量归位的 `llama_model`。

## 2. 问题

llama.cpp 支持 100+ 种模型架构(Llama、Qwen2、Mistral、Falcon、Gemma……),每种架构的层数、头数、FFN 维度、位置编码类型都不同。而 GGUF 文件里的信息是通用的:一些 KV 字符串,加上一堆以"blk.N.attn_q.weight"这类规律命名的张量。

问题是:**程序怎么知道这些 KV 和张量名属于哪种架构,该按什么结构解释它们?**

如果搞不清楚,就不知道模型有多少层、每层的 Q/K/V 权重叫什么名字、RoPE 的 `rope_freq_base` 是多少、应该用什么计算图——一切后续操作都无从进行。

## 3. 朴素思路

把所有可能的参数名都写成一张"条件表":如果文件里有键 `qwen2.context_length`,就是 Qwen2;如果有 `llama.context_length`,就是 Llama。逐一 if-else 匹配,把读到的数值手动塞进对应的 C 结构体字段。

## 4. 为什么朴素思路会崩

- **架构爆炸**。100+ 种架构 × 几十个 hparam 字段 = 几千个 if-else 分支,全部挤在一个函数里。每加一种新架构就要修改这个大函数,极易引入回归。
- **张量命名规律各异**。Qwen2 的注意力权重叫 `blk.N.attn_q.weight`,GPT-NeoX 叫 `gpt_neox.layers.N.attention.query_key_value.weight`。如果"按架构分派"的逻辑不下沉,张量的创建和查找就没法共用同一套索引机制。
- **超参与张量形状强耦合**。`create_tensor` 在创建张量时需要知道 `{n_embd, n_head_kv * n_embd_head}` 这样的形状,而这些形状来自 hparams。如果 hparams 没有先填好,张量创建就会拿到错误维度。
- **运行时多态是更自然的解法**。不同架构"加载超参"和"创建张量"的行为不同,这正是虚函数/多态的使用场景——用继承而非 if-else 来隔离各架构的差异。

## 5. llama.cpp 的做法

llama.cpp 把架构识别分成两个清晰的步骤,并用**虚函数多态**把各架构的差异下沉到子类。

### 步骤 A:根据 `general.architecture` 实例化正确的子类

loader 构造时已经从 KV 里读出架构字符串并转成枚举(`src/llama-model-loader.cpp:551-552`):

```cpp
get_key(llm_kv(LLM_KV_GENERAL_ARCHITECTURE), arch_name, false);
llm_kv = LLM_KV(llm_arch_from_string(arch_name));
```

`llm_arch_from_string` 在 `LLM_ARCH_NAMES` 表里查字符串 → 枚举(`src/llama-arch.cpp:821`):

```cpp
llm_arch llm_arch_from_string(const std::string & name) {
    for (const auto & kv : LLM_ARCH_NAMES) {
        if (kv.second == name) { return kv.first; }
    }
    return LLM_ARCH_UNKNOWN;
}
```

`llama_model_create(ml, params)` 用枚举值 `switch` 到正确的子类构造函数(`src/llama-model.cpp:307`→`293`→`37`):

```text
llm_arch = "qwen2" -> LLM_ARCH_QWEN2
llama_model_mapping(LLM_ARCH_QWEN2, params)
  -> new llama_model_qwen2(params)   // src/llama-model.cpp:84
```

每种架构对应一个 `llama_model_XXX` 子类,其 `load_arch_hparams` 和 `load_arch_tensors` 都是专属实现。

### 步骤 B:load_hparams —— 填充 llama_hparams

`load_hparams`(`src/llama-model.cpp:975`)分两个层次:

1. **通用字段**(`llama_model_base::load_hparams`):从 KV 读出所有架构无关的字段:

```text
LLM_KV_CONTEXT_LENGTH          -> hparams.n_ctx_train
LLM_KV_EMBEDDING_LENGTH        -> hparams.n_embd
LLM_KV_BLOCK_COUNT             -> hparams.n_layer
LLM_KV_ATTENTION_HEAD_COUNT    -> hparams.n_head_arr
LLM_KV_ATTENTION_HEAD_COUNT_KV -> hparams.n_head_kv_arr
LLM_KV_FEED_FORWARD_LENGTH     -> hparams.n_ff_arr
LLM_KV_ROPE_FREQ_BASE          -> hparams.rope_freq_base_train
LLM_KV_ROPE_DIMENSION_COUNT    -> hparams.n_rot_full
  ...
```

2. **架构专属字段**(`load_arch_hparams`,虚函数,由子类实现):以 Qwen2 为例(`src/models/qwen2.cpp:3`):

```cpp
void llama_model_qwen2::load_arch_hparams(llama_model_loader & ml) {
    ml.get_key(LLM_KV_ATTENTION_LAYERNORM_RMS_EPS, hparams.f_norm_rms_eps);
    switch (hparams.n_layer) {
        case 24: type = hparams.n_embd == 1024 ? LLM_TYPE_0_5B : LLM_TYPE_1B; break;
        case 28: type = hparams.n_embd == 1536 ? LLM_TYPE_1_5B : LLM_TYPE_7B; break;
        // ...
    }
}
```

读完 `load_hparams` 之后,`hparams` 里的所有字段都有了正确的值,包括:

```text
hparams.n_ctx_train  = 32768   (Qwen2.5-0.5B 的训练上下文长度)
hparams.n_embd       = 896
hparams.n_layer      = 24
hparams.n_head()     = 14
hparams.n_head_kv()  = 2
hparams.n_ff()       = 4864
hparams.n_rot_full   = 64
hparams.rope_freq_base_train = 1000000.0
```

### 步骤 C:load_vocab —— 填充词表

`load_vocab`(`src/llama-model.cpp:1154`)调用 `vocab.load(ml, kv)`,从 KV 里读出词表类型(BPE/SPM/WPM)、所有 token 字符串、特殊 token id 等。词表加载完成后,`model->vocab` 可以被 `simple.cpp:96` 的 `llama_model_get_vocab` 返回给调用方。

### 步骤 D:load_tensors —— 把权重张量归位到 llama_model 的字段

`load_arch_tensors`(虚函数,子类实现)按架构规律创建每个权重张量并赋给 `llama_model` 的具名字段。以 Qwen2 为例(`src/models/qwen2.cpp:18`):

```cpp
tok_embd = create_tensor(tn(LLM_TENSOR_TOKEN_EMBD, "weight"), {n_embd, n_vocab}, 0);
output_norm = create_tensor(tn(LLM_TENSOR_OUTPUT_NORM, "weight"), {n_embd}, 0);
for (int i = 0; i < n_layer; ++i) {
    layers[i].attn_norm = create_tensor(tn(LLM_TENSOR_ATTN_NORM, "weight", i), {n_embd}, 0);
    layers[i].wq = ...;   layers[i].wk = ...;   layers[i].wv = ...;
    layers[i].ffn_gate = create_tensor(tn(LLM_TENSOR_FFN_GATE, "weight", i), {n_embd, n_ff}, 0);
    // ...
}
```

`tn(LLM_TENSOR_ATTN_Q, "weight", i)` 展开成如 `"blk.0.attn_q.weight"` 的字符串,`create_tensor` 用这个名字在 `weights_map` 里查找对应的偏移,最终把 `ggml_tensor->data` 设好。

整个调用链与状态演进:

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_model_load four-phase: create model, load hparams, load vocab, load tensors">
  <defs>
    <marker id="ar4a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="420" fill="#f8fafc" rx="6"/>
  <rect x="16" y="14" width="210" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="121" y="37" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">llama_model_load()</text>
  <text x="235" y="37" font-size="10" fill="#94a3b8">src/llama.cpp:276</text>
  <line x1="36" y1="50" x2="36" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4a)"/>
  <rect x="36" y="72" width="210" height="60" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="141" y="93" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">① llama_model_create()</text>
  <text x="141" y="109" text-anchor="middle" font-size="11" fill="#64748b">llm_arch_from_string("qwen2")</text>
  <text x="141" y="123" text-anchor="middle" font-size="11" fill="#64748b">new llama_model_qwen2()</text>
  <line x1="246" y1="102" x2="340" y2="102" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4a)"/>
  <rect x="340" y="72" width="400" height="60" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="540" y="93" text-anchor="middle" font-size="11" fill="#64748b">model-&gt;arch = LLM_ARCH_QWEN2</text>
  <text x="540" y="109" text-anchor="middle" font-size="11" fill="#64748b">LLM_ARCH_NAMES 表: "qwen2" → 枚举</text>
  <text x="540" y="123" text-anchor="middle" font-size="10" fill="#94a3b8">llama-model.cpp:84   llama-arch.cpp:821</text>
  <line x1="36" y1="132" x2="36" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4a)"/>
  <rect x="36" y="158" width="210" height="70" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="141" y="179" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">② load_hparams(ml)</text>
  <text x="141" y="196" text-anchor="middle" font-size="11" fill="#64748b">通用字段(基类)</text>
  <text x="141" y="212" text-anchor="middle" font-size="11" fill="#64748b">load_arch_hparams()(虚函数)</text>
  <text x="141" y="224" text-anchor="middle" font-size="10" fill="#94a3b8">llama-model.cpp:975</text>
  <line x1="246" y1="195" x2="340" y2="195" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4a)"/>
  <rect x="340" y="158" width="400" height="70" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="540" y="178" text-anchor="middle" font-size="11" fill="#64748b">n_embd=896, n_layer=24, n_head=14</text>
  <text x="540" y="196" text-anchor="middle" font-size="11" fill="#64748b">n_head_kv=2, n_ff=4864, n_rot=64</text>
  <text x="540" y="213" text-anchor="middle" font-size="11" fill="#64748b">rope_freq_base=1000000.0</text>
  <text x="540" y="225" text-anchor="middle" font-size="10" fill="#94a3b8">hparams 所有字段就绪</text>
  <line x1="36" y1="228" x2="36" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4a)"/>
  <rect x="36" y="254" width="210" height="52" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="141" y="276" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">③ load_vocab(ml)</text>
  <text x="141" y="294" text-anchor="middle" font-size="11" fill="#64748b">vocab.load(ml, kv)</text>
  <text x="141" y="303" text-anchor="middle" font-size="10" fill="#94a3b8">llama-model.cpp:1154</text>
  <line x1="246" y1="280" x2="340" y2="280" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4a)"/>
  <rect x="340" y="254" width="400" height="52" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="540" y="275" text-anchor="middle" font-size="11" fill="#64748b">词表类型(BPE/SPM)、token 字符串</text>
  <text x="540" y="293" text-anchor="middle" font-size="11" fill="#64748b">特殊 token id (bos/eos/pad) 就绪</text>
  <line x1="36" y1="306" x2="36" y2="332" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4a)"/>
  <rect x="36" y="332" width="210" height="70" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="141" y="353" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">④ load_tensors(ml)</text>
  <text x="141" y="370" text-anchor="middle" font-size="11" fill="#64748b">mmap/GPU 上传 (步骤 03)</text>
  <text x="141" y="386" text-anchor="middle" font-size="11" fill="#64748b">load_arch_tensors() 虚函数</text>
  <text x="141" y="398" text-anchor="middle" font-size="10" fill="#94a3b8">llama-model.cpp:1160</text>
  <line x1="246" y1="367" x2="340" y2="367" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4a)"/>
  <rect x="340" y="332" width="400" height="70" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="540" y="352" text-anchor="middle" font-size="11" fill="#64748b">tok_embd, output_norm</text>
  <text x="540" y="368" text-anchor="middle" font-size="11" fill="#64748b">layers[0..23].wq / wk / wv / wo</text>
  <text x="540" y="384" text-anchor="middle" font-size="11" fill="#64748b">ffn_gate / ffn_down / ffn_up</text>
  <text x="540" y="397" text-anchor="middle" font-size="10" fill="#94a3b8">全部 ggml_tensor→data 非空</text>
</svg>
<span class="figure-caption">图 T4.1 ｜ llama_model_load 四阶段:创建子类 → 填 hparams → 加载词表 → 归位张量</span>

<details>
<summary>ASCII 原版</summary>

```
llama_model_load()                        src/llama.cpp:276
  |
  +--> llama_model_create(ml, params)     src/llama.cpp:283
  |      llm_arch_from_string("qwen2")    src/llama-arch.cpp:821
  |      new llama_model_qwen2(params)    src/llama-model.cpp:84
  |      model->arch = LLM_ARCH_QWEN2
  |
  +--> model->load_hparams(ml)            src/llama-model.cpp:975
  |      通用字段 (n_embd, n_layer, ...)
  |      load_arch_hparams() 专属字段     src/models/qwen2.cpp:3
  |
  +--> model->load_vocab(ml)              src/llama-model.cpp:1154
  |      vocab.load(ml, kv)
  |
  +--> model->load_tensors(ml)            src/llama-model.cpp:1160
         ... (步骤 03 中的 mmap/GPU 上传)
         load_arch_tensors()              src/models/qwen2.cpp:18
           tok_embd, output_norm,
           layers[i].wq/wk/wv/wo/...
         <- llama_model.layers[0..23] 全部字段非空
```

</details>

`llama_model_load_from_file` 至此返回——`simple.cpp:89` 那行代码拿到了一个完整的 `llama_model *`。

## 6. 代码位置

按阅读顺序:

- 调用入口:`src/llama.cpp:283` —— `llama_model_create(ml, params)`
- 架构映射表:`src/llama-model.cpp:37` —— `llama_model_mapping` 的 `switch` 块
- `llm_arch_from_string`:`src/llama-arch.cpp:821`
- `LLM_ARCH_NAMES` 字符串表:`src/llama-arch.cpp:9`
- `llm_arch` 枚举定义:`src/llama-arch.h:13`
- `load_hparams` 通用实现:`src/llama-model.cpp:975`
- 通用 hparam 读取(n_embd/n_layer/...):`src/llama-model.cpp:998`-`1010`
- 头数/FFN 读取:`src/llama-model.cpp:1061`-`1066`
- RoPE 参数读取:`src/llama-model.cpp:1075`-`1111`
- `load_arch_hparams` 虚函数声明:`src/llama-model.h:632`
- Qwen2 专属 hparams:`src/models/qwen2.cpp:3`
- `load_vocab` 实现:`src/llama-model.cpp:1154`
- `load_tensors` 实现:`src/llama-model.cpp:1160`
- `load_arch_tensors` 虚函数声明:`src/llama-model.h:633`
- Qwen2 张量创建:`src/models/qwen2.cpp:18`
- `llama_hparams` 结构体:`src/llama-hparams.h:36`
- `llama_layer` 结构体:`src/llama-model.h:213`
- `llama_model_get_vocab`:`src/llama-model.cpp:2141` —— `simple.cpp:96` 的调用对象

## 7. 分支与延伸

- `llama_hparams` 中每个字段的语义、RoPE 参数体系(freq_base / freq_scale / n_rot)、GQA 下 n_head vs n_head_kv 的区别 → [第 3 章 模型架构与超参数](03-model-arch-and-hparams.md)
- `llama_vocab`、BPE/SPM 分词器的 token 表存储、特殊 token (`bos`/`eos`/`pad`)的 id 如何记录 → [第 6 章 分词与词表](06-tokenization.md)
- `llama_layer` 里各张量字段的用途(attn_norm / wq / wk / wv / ffn_gate / ffn_down / ffn_up)如何在计算图里被引用 → [第 3 章](03-model-arch-and-hparams.md)、[第 5 章 计算图构建](05-graph-construction.md)
- `LLM_TN`/`LLM_TENSOR_*` 枚举到 GGUF 张量名字符串的映射 → [第 2 章 GGUF 与模型加载](02-gguf-and-model-loading.md)
- `load_vocab` 中 SentencePiece / tiktoken / BPE 三种词表格式的差异 → [第 6 章 分词与词表](06-tokenization.md)
- 若 `general.architecture` 的值不在 `LLM_ARCH_NAMES` 里,`llm_arch_from_string` 返回 `LLM_ARCH_UNKNOWN`,`llama_model_create` 抛出异常 → [第 3 章](03-model-arch-and-hparams.md)

## 8. 走完这一步你脑子里应该多了什么

1. **架构识别靠一个字符串**。GGUF KV 里的 `general.architecture`(如 `"qwen2"`)经 `llm_arch_from_string` 变成枚举,再经 `llama_model_mapping` 的 `switch` 实例化对应的 C++ 子类——这是 100+ 架构共存的核心机制。
2. **hparams 填充是两级结构**:通用字段由基类 `load_hparams` 统一读取(`n_embd`、`n_layer`、`n_head`、`n_head_kv`、`n_ff`、RoPE 参数),架构专属字段由子类的 `load_arch_hparams` 虚函数补充。
3. **`load_arch_tensors` 是"索引映射"的关键**:它把 `LLM_TENSOR_ATTN_Q` 这样的枚举展开成 `"blk.N.attn_q.weight"` 字符串,在 `weights_map` 里查偏移,最终把 `ggml_tensor` 指针赋给 `layers[i].wq` 这样的有名字段——后续计算图只操作这些有名字段,不再关心文件偏移。
4. **`llama_model_load_from_file` 在这一步之后完全返回**。`simple.cpp:89` 那行代码拿到的指针指向一个架构已知、hparams 全填、词表完整、每个 `ggml_tensor->data` 有效的 `llama_model`。
5. **词表也在这里完成**。`load_vocab` 让 `llama_model_get_vocab(model)` 立刻可用——`simple.cpp:96` 接着就调用它来拿 `vocab` 指针,进而在步骤 09 分词。

下一步:[步骤 05 —— 创建推理上下文](tour-05-create-context.md)。
