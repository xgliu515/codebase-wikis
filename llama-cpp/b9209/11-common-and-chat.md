# 第 11 章 common 工具库与聊天模板

## 总览

`common/` 是 llama.cpp 所有官方工具程序的**胶水层**。它不属于 `libllama` 的公共 C API,不被应用开发者直接链接,而是在工具可执行文件的编译时以静态库 `libcommon` 的形式链接进来。它的职责是:

1. 统一解析数百个命令行选项,并把结果收入 `common_params` 结构体;
2. 一站式初始化 `llama_model` + `llama_context` + 采样器链;
3. 封装聊天模板渲染、结构化输出约束、工具调用解析;
4. 提供日志、模型下载、投机解码等通用功能。

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="common library data flow from CLI/HTTP to final tools">
  <defs>
    <marker id="ar11-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="320" fill="#f8fafc"/>
  <rect x="270" y="16" width="220" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="38" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">命令行 / HTTP 请求</text>
  <line x1="380" y1="52" x2="380" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-1)"/>
  <rect x="220" y="78" width="320" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="350" y="97" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">common_params_parse()</text>
  <text x="565" y="97" text-anchor="middle" font-size="10" fill="#94a3b8">← arg.cpp</text>
  <line x1="380" y1="114" x2="380" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-1)"/>
  <rect x="185" y="140" width="390" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="355" y="159" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">common_init_from_params()</text>
  <text x="590" y="159" text-anchor="middle" font-size="10" fill="#94a3b8">← common.cpp</text>
  <line x1="280" y1="176" x2="200" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-1)"/>
  <line x1="380" y1="176" x2="380" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-1)"/>
  <line x1="480" y1="176" x2="560" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-1)"/>
  <rect x="100" y="210" width="180" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="190" y="231" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">llama_model</text>
  <rect x="295" y="210" width="180" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="385" y="231" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">llama_context</text>
  <rect x="490" y="210" width="180" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="580" y="231" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">common_sampler</text>
  <line x1="380" y1="244" x2="380" y2="268" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-1)"/>
  <rect x="100" y="268" width="560" height="34" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="380" y="287" text-anchor="middle" font-size="11" fill="#64748b">chat.cpp / json-schema-to-grammar.cpp / speculative.cpp</text>
  <line x1="380" y1="302" x2="380" y2="316" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="314" text-anchor="middle" font-size="11" fill="#64748b">最终工具 (llama-cli / llama-server / ...)</text>
</svg>
<span class="figure-caption">图 R11.1 ｜ libcommon 胶水层数据流：从参数解析到工具初始化</span>

<details>
<summary>ASCII 原版</summary>

```
  命令行 / HTTP 请求
       |
  common_params_parse()   ← arg.cpp
       |
  common_init_from_params()  ← common.cpp
       |           \
  llama_model   llama_context   common_sampler
       |
  chat.cpp / json-schema-to-grammar.cpp / speculative.cpp
       |
  最终工具 (llama-cli / llama-server / ...)
```

</details>

关键文件:

| 文件 | 职责 |
|------|------|
| `common/common.h` | 所有公共结构体和函数声明 |
| `common/arg.cpp` | 命令行解析实现 |
| `common/common.cpp` | 工具初始化、批处理工具函数 |
| `common/sampling.h/.cpp` | `common_sampler` 封装 |
| `common/chat.h/.cpp` | 聊天模板渲染和消息解析 |
| `common/json-schema-to-grammar.cpp` | JSON Schema → GBNF |
| `common/jinja/` | 轻量 Jinja 模板引擎 |
| `common/speculative.h/.cpp` | 投机解码框架 |
| `common/download.cpp` | HuggingFace/URL 下载 |
| `common/log.h/.cpp` | 异步日志系统 |

---

## 11.1 `common_params` 结构体

`common_params` 是全局参数的唯一容器,定义于 `common/common.h:423`。它既存放模型加载参数,也存放运行时控制标志,还包含服务器参数、训练参数等细分子结构体。

**主要子结构体:**

```cpp
// common/common.h:423
struct common_params {
    int32_t n_predict = -1;  // 最大生成 token 数,-1 表示无限
    int32_t n_ctx     =  0;  // 上下文长度,0 = 使用模型训练时的值
    int32_t n_batch   = 2048;
    int32_t n_ubatch  =  512;
    // ...
    struct common_params_sampling    sampling;    // 采样参数
    struct common_params_speculative speculative; // 投机解码参数
    struct common_params_model       model;       // 模型路径/HF repo
    // 服务器参数 (仅 llama-server 使用)
    int32_t port = 8080;
    std::string hostname = "127.0.0.1";
    // ...
};
```

`common_params_model`(`common/common.h:291`) 存放多种模型来源:

```cpp
struct common_params_model {
    std::string path;        // 本地路径
    std::string url;         // 直接 URL
    std::string hf_repo;     // HuggingFace repo
    std::string hf_file;     // HF 仓库中的具体文件
    std::string docker_repo; // Docker 镜像
    std::string name;        // <user>/<model>[:<tag>]
};
```

`llama_example` 枚举(`common/common.h:74`)标识当前工具的身份,用于 arg.cpp 中的选项过滤——不同工具只展示与自身相关的选项。

---

## 11.2 参数解析:arg.cpp

### 整体架构

`common/arg.cpp` 中所有命令行选项统一用 `common_arg` 结构体描述(`common/arg.h:19`):

```cpp
// common/arg.h:19
struct common_arg {
    std::set<enum llama_example> examples; // 适用工具集合
    std::set<enum llama_example> excludes; // 排除工具集合
    std::vector<const char *> args;        // 选项名,如 {"--ctx-size", "-c"}
    std::vector<const char *> args_neg;    // 对立选项,如 {"--no-xxx"}
    const char * env = nullptr;            // 对应环境变量名
    bool is_sampling = false;              // 是否为采样参数
    // 回调函数,仅使用其中一个:
    void (*handler_void)   (common_params &) = nullptr;
    void (*handler_string) (common_params &, const std::string &) = nullptr;
    void (*handler_int)    (common_params &, int) = nullptr;
    void (*handler_bool)   (common_params &, bool) = nullptr;
};
```

所有选项在 `common_params_parser_init()` 中一次性定义,形成 `std::vector<common_arg>`。每个选项通过 `.set_examples({...})` 声明适用工具,通过 `.set_env("LLAMA_XXX")` 关联环境变量。

**选项过滤机制:**解析时,调用 `arg.in_example(ex)` 检查当前工具是否应支持该选项;若不支持则跳过。这使得数百个选项可以共存于同一代码文件而不互相干扰。

### 入口函数

```cpp
// common/arg.h:122
bool common_params_parse(int argc, char ** argv, common_params & params,
                         llama_example ex,
                         void(*print_usage)(int, char **) = nullptr);
```

内部流程:
1. 调用 `common_params_parser_init()` 生成选项列表。
2. 遍历 `argv`,对每个 `--xxx` 匹配 `common_arg`,调用对应 handler 写入 `params`。
3. 解析完成后,调用 `common_params_handle_models()` 处理 `-hf` 等模型下载相关参数。
4. 若某个选项的环境变量已设置(`.get_value_from_env()`),则在命令行未提供时使用环境变量值。

### 环境变量支持

通过 `common_arg::set_env(const char * env)` 注册(`common/arg.cpp:93`):

```cpp
common_arg & common_arg::set_env(const char * env) {
    help = help + "\n(env: " + env + ")";
    this->env = env;
    return *this;
}
```

help 字符串中会自动追加环境变量名称,便于 `--help` 输出。

---

## 11.3 `common_init_from_params`:一站式初始化

`common_init_from_params()` 是工具程序调用 `libllama` 的入口桥梁,定义于 `common/common.h:878`。

```cpp
// common/common.h:878
common_init_result_ptr common_init_from_params(common_params & params);
```

返回 `common_init_result`,通过 pimpl 模式隐藏实现细节(`common/common.h:859`):

```cpp
struct common_init_result {
    common_init_result(common_params & params); // 构造时即完成加载
    llama_model   * model();
    llama_context * context();
    common_sampler * sampler(llama_seq_id seq_id);
    void reset_samplers();
    std::vector<llama_adapter_lora_ptr> & lora();
private:
    struct impl;
    std::unique_ptr<impl> pimpl;
};
```

`common_init_from_params` 内部调用链(见 `common/common.cpp:1312`):

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="common_init_from_params internal call chain">
  <defs>
    <marker id="ar11-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="380" fill="#f8fafc"/>
  <rect x="180" y="12" width="340" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="350" y="34" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">common_init_from_params(params)</text>
  <line x1="250" y1="48" x2="250" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-2)"/>
  <rect x="60" y="72" width="380" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="190" y="90" text-anchor="middle" font-size="11" fill="#64748b">common_model_params_to_llama(params)</text>
  <text x="460" y="90" text-anchor="middle" font-size="11" fill="#0d9488">→ llama_model_params</text>
  <line x1="250" y1="102" x2="250" y2="122" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-2)"/>
  <rect x="60" y="122" width="380" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="250" y="141" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">llama_model_load_from_file(path, mparams)</text>
  <line x1="250" y1="152" x2="250" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-2)"/>
  <rect x="60" y="172" width="380" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="190" y="190" text-anchor="middle" font-size="11" fill="#64748b">common_context_params_to_llama(params)</text>
  <text x="460" y="190" text-anchor="middle" font-size="11" fill="#0d9488">→ llama_context_params</text>
  <line x1="250" y1="202" x2="250" y2="222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-2)"/>
  <rect x="60" y="222" width="380" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="250" y="241" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">llama_init_from_model(model, cparams)</text>
  <line x1="250" y1="252" x2="250" y2="272" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-2)"/>
  <rect x="60" y="272" width="220" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="170" y="289" text-anchor="middle" font-size="11" fill="#64748b">common_control_vector_load()</text>
  <text x="295" y="289" text-anchor="start" font-size="10" fill="#94a3b8">[如有 control vector]</text>
  <line x1="250" y1="300" x2="250" y2="318" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-2)"/>
  <rect x="60" y="318" width="220" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="170" y="335" text-anchor="middle" font-size="11" fill="#64748b">common_set_adapter_lora()</text>
  <text x="295" y="335" text-anchor="start" font-size="10" fill="#94a3b8">[如有 LoRA 适配器]</text>
  <line x1="250" y1="346" x2="250" y2="358" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-2)"/>
  <rect x="60" y="344" width="380" height="28" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="180" y="361" text-anchor="middle" font-size="11" fill="#16a34a">common_sampler_init()</text>
  <text x="420" y="361" text-anchor="middle" font-size="11" fill="#0d9488">→ common_sampler*</text>
</svg>
<span class="figure-caption">图 R11.2 ｜ common_init_from_params 内部调用链：模型加载、上下文初始化到采样器构建</span>

<details>
<summary>ASCII 原版</summary>

```
common_init_from_params(params)
  |
  +-- common_model_params_to_llama(params)    → llama_model_params
  +-- llama_model_load_from_file(path, mparams)
  |
  +-- common_context_params_to_llama(params) → llama_context_params
  +-- llama_init_from_model(model, cparams)
  |
  +-- common_control_vector_load()           [如有 control vector]
  +-- common_set_adapter_lora()              [如有 LoRA 适配器]
  +-- warmup run                             [可选预热]
  |
  +-- common_sampler_init()                  → common_sampler*
```

</details>

关键参数映射函数(位于 `common/common.cpp:1515` 和 `1554`):

```cpp
// common/common.cpp:1515
struct llama_model_params common_model_params_to_llama(common_params & params) {
    // 把 common_params 的 n_gpu_layers、devices、split_mode 等
    // 映射到 llama_model_params
}

// common/common.cpp:1554
struct llama_context_params common_context_params_to_llama(const common_params & params) {
    // 把 n_ctx、n_batch、n_ubatch、cache_type_k/v 等
    // 映射到 llama_context_params
}
```

---

## 11.4 采样参数封装:common_sampler

### common_params_sampling

`common_params_sampling`(`common/common.h:210`)存放采样超参数。其默认采样器链顺序体现了一般最优实践:

```cpp
// common/common.h:247
std::vector<enum common_sampler_type> samplers = {
    COMMON_SAMPLER_TYPE_PENALTIES,    // 重复惩罚
    COMMON_SAMPLER_TYPE_DRY,          // DRY 重复惩罚
    COMMON_SAMPLER_TYPE_TOP_N_SIGMA,  // 按标准差截断
    COMMON_SAMPLER_TYPE_TOP_K,
    COMMON_SAMPLER_TYPE_TYPICAL_P,
    COMMON_SAMPLER_TYPE_TOP_P,
    COMMON_SAMPLER_TYPE_MIN_P,
    COMMON_SAMPLER_TYPE_XTC,          // Exclude Top Choices
    COMMON_SAMPLER_TYPE_TEMPERATURE,
};
```

### common_sampler 结构

`common_sampler`(`common/sampling.cpp:111`)是对底层 `llama_sampler` 链的高层封装,其核心成员:

```cpp
// common/sampling.cpp:111
struct common_sampler {
    common_params_sampling params;

    struct llama_sampler * grmr;    // 语法采样器 (GBNF / llguidance)
    struct llama_sampler * rbudget; // 推理 budget 采样器
    struct llama_sampler * chain;   // 主采样器链

    ring_buffer<llama_token> prev;  // 最近 n_prev 个 token 的历史
    std::vector<llama_token_data> cur;
    llama_token_data_array cur_p;
};
```

**与底层 `llama_sampler` 的关系:**`common_sampler` 不替换底层接口,而是在其之上增加:
- 语法约束(lazy grammar:仅在遇到触发词时激活,避免每步都进行全词表约束);
- 推理预算控制(`reasoning_budget_tokens`);
- token 历史 ring buffer(`prev`,用于重复惩罚上下文);
- 候选 token 列表(`cur_p`,用于返回 top-n 概率)。

### 采样流程

```cpp
// common/sampling.h:65
llama_token common_sampler_sample(
    struct common_sampler * gsmpl,
    struct llama_context * ctx,
    int idx,
    bool grammar_first = false);
```

默认路径(grammar_first = false):

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="common_sampler_sample fast and slow path flow">
  <defs>
    <marker id="ar11-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar11-3g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#16a34a"/></marker>
    <marker id="ar11-3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="360" fill="#f8fafc"/>
  <rect x="270" y="12" width="180" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="360" y="32" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">logits[idx]</text>
  <line x1="360" y1="44" x2="360" y2="66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-3)"/>
  <rect x="200" y="66" width="320" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="84" text-anchor="middle" font-size="11" fill="#64748b">set_logits()</text>
  <text x="450" y="84" text-anchor="middle" font-size="10" fill="#94a3b8">填充 cur_p</text>
  <line x1="360" y1="96" x2="360" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-3)"/>
  <rect x="160" y="116" width="400" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="340" y="134" text-anchor="middle" font-size="11" fill="#64748b">llama_sampler_apply(chain, &amp;cur_p)</text>
  <text x="510" y="134" text-anchor="middle" font-size="10" fill="#94a3b8">主链过滤</text>
  <line x1="360" y1="146" x2="360" y2="166" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-3)"/>
  <rect x="160" y="166" width="400" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="340" y="184" text-anchor="middle" font-size="11" fill="#64748b">llama_sampler_sample(chain, ...)</text>
  <text x="510" y="184" text-anchor="middle" font-size="10" fill="#94a3b8">从 cur_p 中采样</text>
  <line x1="360" y1="196" x2="360" y2="216" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-3)"/>
  <rect x="190" y="216" width="340" height="32" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="360" y="236" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">检查 token 是否满足语法</text>
  <line x1="560" y1="232" x2="660" y2="232" stroke="#16a34a" stroke-width="1.2" marker-end="url(#ar11-3g)"/>
  <text x="610" y="224" text-anchor="middle" font-size="10" fill="#16a34a">满足</text>
  <rect x="660" y="214" width="90" height="32" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="705" y="234" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">直接返回</text>
  <line x1="360" y1="248" x2="360" y2="272" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar11-3r)"/>
  <text x="380" y="264" text-anchor="start" font-size="10" fill="#dc2626">不满足</text>
  <rect x="120" y="272" width="480" height="30" rx="5" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="310" y="290" text-anchor="middle" font-size="11" fill="#dc2626">llama_sampler_apply(grmr, &amp;cur_p)</text>
  <text x="520" y="290" text-anchor="middle" font-size="10" fill="#94a3b8">重新约束</text>
  <line x1="360" y1="302" x2="360" y2="322" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar11-3r)"/>
  <rect x="220" y="322" width="280" height="28" rx="5" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="360" y="340" text-anchor="middle" font-size="11" fill="#dc2626">再次采样（慢路径）</text>
</svg>
<span class="figure-caption">图 R11.3 ｜ common_sampler_sample 采样流程：快路径直接返回，慢路径语法重约束</span>

<details>
<summary>ASCII 原版</summary>

```
logits[idx]
  → set_logits()          填充 cur_p
  → llama_sampler_apply(chain, &cur_p)   主链过滤
  → llama_sampler_sample(chain, ...)     从 cur_p 中采样
  → 检查 token 是否满足语法
      满足 → 直接返回
      不满足 → llama_sampler_apply(grmr, &cur_p)  重新约束
             → 再次采样(慢路径)
```

</details>

投机解码场景下使用 `common_sampler_sample_and_accept_n()`(`common/sampling.h:83`),同时对若干草稿 token 批量验证。

---

## 11.5 聊天模板:chat.h/.cpp 与 Jinja 引擎

### 消息结构

`common_chat_msg`(`common/chat.h:81`)是对 OpenAI ChatML 格式的 C++ 表示:

```cpp
// common/chat.h:81
struct common_chat_msg {
    std::string                               role;
    std::string                               content;
    std::vector<common_chat_msg_content_part> content_parts; // 多模态内容
    std::vector<common_chat_tool_call>        tool_calls;
    std::string                               reasoning_content; // <think>...</think>
    std::string                               tool_name;
    std::string                               tool_call_id;
};
```

### 模板检测与初始化

`common_chat_templates_init()`(`common/chat.h:243`)从模型 GGUF 元数据读取 `tokenizer.chat_template` 字段,如果存在则使用模型自带模板;否则根据 `--chat-template` 参数或内置名称匹配:

```cpp
// common/chat.h:243
common_chat_templates_ptr common_chat_templates_init(
    const struct llama_model * model,
    const std::string &        chat_template_override,
    const std::string &        bos_token_override = "",
    const std::string &        eos_token_override = "");
```

### Jinja 引擎架构

`common/jinja/` 实现了一个专用 Jinja2 子集(`common/jinja/README.md`):

<svg viewBox="0 0 760 140" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Jinja template engine pipeline from source to rendered prompt">
  <defs>
    <marker id="ar11-4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="140" fill="#f8fafc"/>
  <rect x="20" y="50" width="110" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="75" y="67" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">模板字符串</text>
  <text x="75" y="82" text-anchor="middle" font-size="10" fill="#64748b">template src</text>
  <line x1="130" y1="70" x2="162" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-4)"/>
  <rect x="162" y="42" width="140" height="56" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="232" y="64" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">lexer::tokenize()</text>
  <text x="232" y="79" text-anchor="middle" font-size="10" fill="#64748b">词法分析</text>
  <text x="232" y="91" text-anchor="middle" font-size="10" fill="#94a3b8">→ tokens</text>
  <line x1="302" y1="70" x2="334" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-4)"/>
  <rect x="334" y="42" width="150" height="56" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="409" y="64" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">parse_from_tokens()</text>
  <text x="409" y="79" text-anchor="middle" font-size="10" fill="#64748b">语法分析</text>
  <text x="409" y="91" text-anchor="middle" font-size="10" fill="#94a3b8">→ jinja::program (AST)</text>
  <line x1="484" y1="70" x2="516" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-4)"/>
  <rect x="516" y="42" width="130" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="581" y="64" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">runtime::execute()</text>
  <text x="581" y="79" text-anchor="middle" font-size="10" fill="#64748b">注入 messages/tools</text>
  <text x="581" y="91" text-anchor="middle" font-size="10" fill="#94a3b8">运行 AST</text>
  <line x1="646" y1="70" x2="678" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-4)"/>
  <rect x="678" y="50" width="70" height="40" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="713" y="67" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">渲染完成</text>
  <text x="713" y="82" text-anchor="middle" font-size="10" fill="#64748b">提示字符串</text>
</svg>
<span class="figure-caption">图 R11.4 ｜ Jinja 模板引擎管道：词法 → 语法 → AST 执行 → 渲染提示</span>

<details>
<summary>ASCII 原版</summary>

```
模板字符串
  → jinja::lexer::tokenize()    词法分析
  → jinja::parse_from_tokens()  语法分析 → jinja::program (AST)
  → jinja::runtime::execute()   运行 AST,注入 messages/tools 等变量
  → 渲染完成的提示字符串
```

</details>

引擎使用 `jinja::string` 包装字符串并携带 `is_input` 标记,防止用户输入注入特殊 token。

`common_chat_template` 构造器在初始化时完成编译(`common/chat.h:59`):

```cpp
// common/chat.h:59
common_chat_template(const std::string & src,
                     const std::string & bos_token,
                     const std::string & eos_token) {
    jinja::lexer lexer;
    auto lexer_res = lexer.tokenize(src);
    this->prog = jinja::parse_from_tokens(lexer_res);
    this->caps = jinja::caps_get(prog); // 检测模板能力
}
```

`jinja::caps_get(prog)` 静态分析 AST,检测模板是否支持工具调用、thinking 标签等,结果存入 `chat_template_caps`(`common/chat.h:19`)。

### 模板渲染

```cpp
// common/chat.h:251
struct common_chat_params common_chat_templates_apply(
    const struct common_chat_templates *        tmpls,
    const struct common_chat_templates_inputs & inputs);
```

输入 `common_chat_templates_inputs`(`common/chat.h:178`)包含:
- `messages`:对话历史;
- `tools`:工具定义列表;
- `tool_choice`:工具调用策略(AUTO/REQUIRED/NONE);
- `reasoning_format`:思维链格式;
- `enable_thinking`:是否启用思考模式。

输出 `common_chat_params`(`common/chat.h:198`)包含:
- `prompt`:渲染完毕的提示字符串;
- `grammar`:配套的 GBNF 语法约束(如有工具调用);
- `format`:解析格式标识(CONTENT_ONLY / PEG_SIMPLE / PEG_NATIVE / PEG_GEMMA4);
- `grammar_triggers`:懒语法触发条件;
- `thinking_start_tag` / `thinking_end_tag`。

---

## 11.6 结构化输出与工具调用解析

### JSON Schema → GBNF

`common/json-schema-to-grammar.cpp` 将 JSON Schema 转换为 GBNF(llama.cpp 的 BNF 语法格式),使模型输出强制符合 Schema:

```cpp
// common/json-schema-to-grammar.h
std::string json_schema_to_grammar(const nlohmann::json & schema);
```

转换规则:
- `"type": "object"` → GBNF `object` 规则,递归处理每个属性;
- `"type": "array"` → 用 `build_repetition()` 生成重复规则;
- `"enum"` → 逐字面量枚举;
- 整数范围约束(`minimum`/`maximum`) → `build_min_max_int()`(`common/json-schema-to-grammar.cpp:44`)精确生成数字范围规则。

语法类型通过 `common_grammar_type` 枚举区分(`common/common.h:172`):

```cpp
enum common_grammar_type {
    COMMON_GRAMMAR_TYPE_NONE,
    COMMON_GRAMMAR_TYPE_USER,          // 用户手动提供的 GBNF
    COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT, // --json-schema 自动生成
    COMMON_GRAMMAR_TYPE_TOOL_CALLS,    // 工具调用格式
};
```

`common_grammar_needs_prefill(g)` 判断是否需要将 `generation_prompt` 预填充到语法采样器中,以跳过模型已输出的前缀 token。

### 工具调用解析

工具调用输出解析分三层:

**1. PEG 解析器** (`common/peg-parser.h`, `common/chat-peg-parser.h`)

PEG(解析表达式语法)比正则表达式更适合处理嵌套结构。`common_chat_peg_parse()` 根据 `common_chat_format` 选择对应格式的 PEG 规则,解析工具调用输出。

**2. Auto 解析器** (`common/chat-auto-parser.h`)

`chat-auto-parser` 在 PEG 之上提供更高层的抽象。通过 `chat-auto-parser-helpers.cpp` 中的辅助函数自动识别模型特定的工具调用格式,并动态生成 PEG 程序。

**3. 统一入口**

```cpp
// common/chat.h:267
common_chat_msg common_chat_parse(
    const std::string & input,
    bool is_partial,           // 是否为流式中间片段
    const common_chat_parser_params & params);
```

`common_chat_parser_params` 包含格式标识、推理格式、是否回显 generation_prompt 等控制标志。

**流式差量计算:**`common_chat_msg_diff::compute_diffs()`(`common/chat.h:137`)对比前后两次累积输出,提取 content/tool_call 的增量,供流式 SSE 推送使用。

---

## 11.7 日志系统

`common/log.h` 定义了分级宏 `LOG_INF`, `LOG_WRN`, `LOG_ERR`, `LOG_DBG`:

```cpp
// common/log.h:24-30
#define LOG_LEVEL_DEBUG  5
#define LOG_LEVEL_TRACE  4
#define LOG_LEVEL_INFO   3
#define LOG_LEVEL_WARN   2
#define LOG_LEVEL_ERROR  1
#define LOG_LEVEL_OUTPUT 0   // 工具程序的数据输出通道
```

`common_log`(`common/log.h:50`)使用内部 worker 线程异步写日志,避免 I/O 阻塞推理循环。`common_log_main()` 返回进程级单例。日志支持可选时间戳、颜色、JSON 格式(`--log-json`)。

---

## 11.8 模型下载

`common/download.h` 提供两种下载路径:

```cpp
// common/download.h:90
common_download_model_result common_download_model(
    const common_params_model & model,
    const common_download_opts & opts = {},
    bool download_mmproj = false,
    bool download_mtp    = false);
```

下载逻辑:
- **HF repo**:解析 `hf_repo` + `hf_file`,访问 HuggingFace Hub API,使用 ETag 缓存。分片 GGUF(`model-00001-of-00003.gguf`)自动检测并批量下载所有分片。
- **URL**:直接 HTTP GET,ETag 缓存于 `~/.cache/llama.cpp/`。
- **Docker**:调用 `common_docker_resolve_model()` 从 OCI 镜像仓库拉取。
- **离线模式**(`opts.offline = true`):不发起任何网络请求。

`--hf-repo` / `--hf-file` 命令行参数最终将路径写入 `params.model.hf_repo` 和 `params.model.hf_file`,由 `common_params_handle_models()` 统一处理下载并填充本地路径。

---

## 11.9 投机解码框架

`common/speculative.h` 定义了统一的投机解码接口,支持多种后端:

```cpp
// common/common.h:159
enum common_speculative_type {
    COMMON_SPECULATIVE_TYPE_NONE,
    COMMON_SPECULATIVE_TYPE_DRAFT_SIMPLE,   // 独立草稿模型
    COMMON_SPECULATIVE_TYPE_DRAFT_EAGLE3,   // Eagle3 算法
    COMMON_SPECULATIVE_TYPE_DRAFT_MTP,      // 多 token 预测
    COMMON_SPECULATIVE_TYPE_NGRAM_SIMPLE,   // n-gram 自投机
    COMMON_SPECULATIVE_TYPE_NGRAM_MAP_K,    // n-gram + k 值映射
    COMMON_SPECULATIVE_TYPE_NGRAM_MAP_K4V,  // n-gram + k/v 映射
    COMMON_SPECULATIVE_TYPE_NGRAM_MOD,
    COMMON_SPECULATIVE_TYPE_NGRAM_CACHE,    // 3 级 n-gram 缓存
};
```

`common_speculative` 对象通过 `common_speculative_init()` 初始化,之后的每轮生成流程(`common/speculative.h:51-66`):

<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="speculative decoding sequence: begin draft validate accept">
  <defs>
    <marker id="ar11-5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="640" height="240" fill="#f8fafc"/>
  <rect x="140" y="16" width="360" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="280" y="33" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">common_speculative_begin()</text>
  <text x="480" y="38" text-anchor="start" font-size="10" fill="#94a3b8">新请求开始，记录 prompt</text>
  <line x1="320" y1="54" x2="320" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-5)"/>
  <rect x="140" y="78" width="360" height="38" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="280" y="95" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">common_speculative_draft()</text>
  <text x="490" y="100" text-anchor="start" font-size="10" fill="#94a3b8">生成草稿 token 序列</text>
  <line x1="320" y1="116" x2="320" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-5)"/>
  <rect x="100" y="140" width="440" height="38" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="320" y="157" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">目标模型 llama_decode 批量验证</text>
  <text x="320" y="172" text-anchor="middle" font-size="10" fill="#94a3b8">1 + n_draft 个位置同时计算 logits</text>
  <line x1="320" y1="178" x2="320" y2="202" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11-5)"/>
  <rect x="140" y="202" width="360" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="280" y="219" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">common_speculative_accept()</text>
  <text x="490" y="220" text-anchor="start" font-size="10" fill="#94a3b8">告知接受了多少草稿 token</text>
</svg>
<span class="figure-caption">图 R11.5 ｜ 投机解码每轮生成序列：开始 → 草稿 → 批量验证 → 接受</span>

<details>
<summary>ASCII 原版</summary>

```
common_speculative_begin()   // 新请求开始,记录 prompt
  |
common_speculative_draft()   // 生成草稿 token 序列
  |
[目标模型 llama_decode 批量验证]
  |
common_speculative_accept()  // 告知接受了多少草稿 token
```

</details>

**n-gram 缓存** (`common/ngram-cache.h`):`NGRAM_CACHE` 类型维护 3 级静态/动态 n-gram 查找表,无需草稿模型即可自投机。动态缓存在生成过程中持续更新。

---

## 11.10 其它实用组件

### `common/console.h`

跨平台终端控制:颜色输出、readline 支持、spinner 动画(`console::spinner::start/stop`)、不同显示类型(`DISPLAY_TYPE_USER_INPUT`、`DISPLAY_TYPE_REASONING`)。

### `common/unicode.h`

UTF-8 验证、字符分类、正则部分匹配(`common/regex-partial.h`),用于检测生成 token 是否截断了 UTF-8 多字节序列。

### `common/preset.h`

模型预设系统,允许在配置文件或 `--models-dir` 目录中预定义模型参数集合,供 llama-server 的路由模式按名称加载。

### `common/reasoning-budget.h`

推理预算采样器:在思维链模型(`<think>...</think>`)超过 token 预算时,强制注入结束标签序列。预算参数通过 `common_params_sampling::reasoning_budget_tokens` 设置,由 `common_sampler_init()` 构造对应的 `llama_sampler` 节点。
