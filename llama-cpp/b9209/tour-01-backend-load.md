# Trace 步骤 01 —— 程序还没碰模型,为什么第一句是"加载后端"?

## 1. 当前情境

进程刚启动。`main` 解析完 `-m`、`-n`、prompt 三个参数(`examples/simple/simple.cpp:28`-`78`),此刻内存里只有几个 C++ 字符串和整数,没有模型、没有张量、没有任何 GPU 资源。

`simple.cpp` 在碰模型之前做的第一件正事,是这一行(`examples/simple/simple.cpp:82`):

```cpp
// load dynamic backends
ggml_backend_load_all();
```

它既不读模型文件,也不分配显存。它要解决的,是一个比"加载模型"更靠前的问题。

## 2. 问题

llama.cpp 要能在天差地别的机器上跑:一台只有 CPU 的服务器、一台带 Apple Silicon 的 MacBook、一台插了 NVIDIA 显卡的工作站。每种硬件对应一套**后端**(backend)——一组针对该硬件实现的张量算子(matmul、softmax、rope……)。

问题是:**这一份二进制,怎么知道当前这台机器上有哪些后端可用,并且把它们准备好待命?** 如果搞不清楚,后面建计算图时就不知道能往哪个设备上派活,`-ngl 99`(把 99 层放 GPU)这种请求也无从满足。

## 3. 朴素思路

最直接的办法:**编译期决定**。编译时打开 `GGML_USE_CUDA`,生成的二进制就直接 `#include` CUDA 后端、把它静态链进去、启动时无条件注册。想要 Metal 版就另编一个。用户根据自己的机器下对应的包。

这听起来很合理 —— 反正一台机器的硬件是固定的,编译期写死有什么不好?

## 4. 为什么朴素思路会崩

- **发布矩阵爆炸**:CPU、CUDA、HIP、Metal、Vulkan、SYCL、CANN…… 十几种后端,还要乘以 CPU 指令集(AVX2 / AVX512 / NEON)、操作系统、架构。纯静态链接意味着要发布几十上百个二进制包,用户还得自己选对。
- **同机多后端选不了**:一台装了 NVIDIA 卡的机器,既能跑 CUDA 也能跑 Vulkan 还能退回 CPU。静态写死一种,就丧失了运行时根据情况挑最优、或在驱动缺失时优雅降级的能力。
- **CUDA 缺失直接崩**:静态链接 CUDA 后端的二进制,丢到一台没装 CUDA 驱动的机器上,往往在动态链接器阶段就加载失败,程序根本起不来 —— 而它本该能退回 CPU 安静地跑。
- **下游打包困难**:发行版、HuggingFace 这类下游想统一打一个包,静态方案逼着他们为每种硬件维护一条流水线。

核心矛盾:**硬件能力是运行时才知道的事实,却被塞进了编译期决策。**

## 5. llama.cpp 的做法

llama.cpp 把后端做成**可在运行时发现并装载的插件**,用一张全局注册表 + 两条装载路径解决问题。

**全局注册表**。`ggml_backend_registry` 是个进程级单例(`ggml/src/ggml-backend-reg.cpp:111`,通过 `get_reg()` 的函数内 `static` 实现懒初始化,`ggml-backend-reg.cpp:285`)。它持有两个列表:已注册的 `backends`(后端,即 reg)和 `devices`(具体设备)。

**路径一:编译期静态注册**。注册表的构造函数里,对每个在编译时启用的后端调一次 `register_backend`(`ggml-backend-reg.cpp:115`-`166`):

```cpp
ggml_backend_registry() {
#ifdef GGML_USE_CUDA
    register_backend(ggml_backend_cuda_reg());
#endif
#ifdef GGML_USE_METAL
    register_backend(ggml_backend_metal_reg());
#endif
    // ... vulkan / sycl / blas / ...
    register_backend(ggml_backend_cpu_reg());   // CPU 永远在,且放最后
}
```

注意 CPU 后端永远注册、且排在最后 —— 它是所有硬件的兜底。

**路径二:运行时动态装载**。这正是 `ggml_backend_load_all()` 干的事(`ggml-backend-reg.cpp:555`)。它对每种后端名字调一次 `ggml_backend_load_best`,去约定目录里找名为 `libggml-cuda.so` / `ggml-metal.dll` 之类的动态库:

```cpp
void ggml_backend_load_all_from_path(const char * dir_path) {
    ggml_backend_load_best("blas",   silent, dir_path);
    ggml_backend_load_best("cuda",   silent, dir_path);
    ggml_backend_load_best("metal",  silent, dir_path);
    ggml_backend_load_best("vulkan", silent, dir_path);
    // ... 一长串 ...
    ggml_backend_load_best("cpu",    silent, dir_path);
    const char * backend_path = std::getenv("GGML_BACKEND_PATH");
    if (backend_path) {
        ggml_backend_load(backend_path);   // 允许装树外后端
    }
}
```

关键点:**找不到某个后端的动态库,不是错误,只是跳过**。一台没有 NVIDIA 卡的机器上,`libggml-cuda` 根本不存在,`load_best` 静默返回,程序继续。这就是"优雅降级"——能用 GPU 就用,不能就退回路径一里那个永远在场的 CPU 后端。`silent` 在 release 构建(`NDEBUG`)下为真,所以正常用户看不到一堆"未找到"刷屏(`ggml-backend-reg.cpp:560`-`564`)。

走完这一行,全局注册表里就躺着这台机器**实际可用**的全部后端。后面 `llama_init_from_model` 建后端实例、计算图分派设备,都从这张表里取。

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ggml_backend_load_all call flow and registry structure">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar1d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="320" fill="#f8fafc" rx="6"/>
  <rect x="20" y="16" width="200" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="120" y="39" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ggml_backend_load_all()</text>
  <line x1="120" y1="52" x2="120" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="20" y="80" width="200" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="120" y="103" text-anchor="middle" font-size="11" fill="#64748b">对每种后端名循环调用</text>
  <line x1="120" y1="116" x2="120" y2="144" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="20" y="144" width="200" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="120" y="162" text-anchor="middle" font-size="11" fill="#64748b">ggml_backend_load_best(</text>
  <text x="120" y="175" text-anchor="middle" font-size="11" fill="#64748b">"cuda" / "metal" / ...)</text>
  <line x1="220" y1="162" x2="290" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="220" y1="162" x2="290" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="290" y="108" width="220" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="400" y="128" text-anchor="middle" font-size="11" fill="#64748b">找到 libggml-&lt;name&gt;.{so,dylib}</text>
  <text x="400" y="144" text-anchor="middle" font-size="11" fill="#64748b">dlopen → register_backend()</text>
  <rect x="290" y="178" width="220" height="36" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="400" y="192" text-anchor="middle" font-size="11" fill="#64748b">没找到</text>
  <text x="400" y="207" text-anchor="middle" font-size="11" fill="#94a3b8">→ 静默跳过(不报错)</text>
  <line x1="510" y1="130" x2="580" y2="130" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar1d)"/>
  <rect x="580" y="62" width="160" height="200" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="660" y="88" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">registry 单例</text>
  <line x1="580" y1="100" x2="740" y2="100" stroke="#7c3aed" stroke-width="0.8" stroke-dasharray="2,2"/>
  <text x="592" y="120" font-size="11" fill="#64748b">backends:</text>
  <rect x="592" y="128" width="136" height="22" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="660" y="143" text-anchor="middle" font-size="10" fill="#64748b">CUDA · Metal · … · CPU</text>
  <text x="592" y="172" font-size="11" fill="#64748b">devices:</text>
  <rect x="592" y="180" width="136" height="22" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="660" y="195" text-anchor="middle" font-size="10" fill="#64748b">GPU0 · GPU1 · … · CPU</text>
  <text x="660" y="248" text-anchor="middle" font-size="10" fill="#94a3b8">CPU 永远在场(兜底)</text>
  <line x1="120" y1="180" x2="120" y2="260" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar1d)"/>
  <rect x="20" y="260" width="200" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="120" y="278" text-anchor="middle" font-size="11" fill="#64748b">CPU 后端</text>
  <text x="120" y="291" text-anchor="middle" font-size="11" fill="#64748b">ggml_backend_cpu_reg() 兜底</text>
</svg>
<span class="figure-caption">图 T1.1 ｜ ggml_backend_load_all 的装载流程与注册表结构</span>

<details>
<summary>ASCII 原版</summary>

```
ggml_backend_load_all()
        |
        +--> 对每种后端名 ggml_backend_load_best("cuda" / "metal" / ...)
        |        |
        |        +--> 在搜索目录找 libggml-<name>.{so,dylib,dll}
        |        +--> 找到 -> dlopen -> 调其 ggml_backend_*_reg() -> register_backend()
        |        +--> 没找到 -> 静默跳过
        |
        v
   ggml_backend_registry 单例
   ├─ backends: [ (CUDA) (Metal) ... CPU ]   <- 这台机器真实可用的
   └─ devices:  [ GPU0  GPU1  ...  CPU    ]
```

</details>

## 6. 代码位置

按这个顺序读:

- 入口:`examples/simple/simple.cpp:82` —— `ggml_backend_load_all()` 调用点
- 实现:`ggml/src/ggml-backend-reg.cpp:555` —— `ggml_backend_load_all` → `ggml_backend_load_all_from_path:559`
- 注册表结构:`ggml/src/ggml-backend-reg.cpp:111` —— `struct ggml_backend_registry`
- 静态注册:`ggml/src/ggml-backend-reg.cpp:115`-`166` —— 构造函数里的编译期 `register_backend`
- 单例获取:`ggml/src/ggml-backend-reg.cpp:285` —— `get_reg()`
- 动态装载选优:`ggml/src/ggml-backend-reg.cpp:473` —— `ggml_backend_load_best`
- 对外计数 API:`ggml/include/ggml-backend.h:234`、`:239` —— `ggml_backend_reg_count` / `ggml_backend_dev_count`

## 7. 分支与延伸

- 后端抽象到底是什么、`ggml_backend` / `ggml_backend_device` / `ggml_backend_buffer_type` 怎么分层 → [第 9 章 GGML 后端系统](09-ggml-backend.md)
- 动态库装载的细节(`dlopen`、符号查找、`ggml-backend-dl`)→ [第 9 章 §运行时注册与发现](09-ggml-backend.md)
- 注册好的后端在创建上下文时怎么被实例化、怎么被 scheduler 用 → [步骤 05:创建推理上下文](tour-05-create-context.md)
- 计算图最终怎么被派到这些后端上执行 → [步骤 13:后端执行前向计算](tour-13-backend-compute.md)
- 编译期 `GGML_USE_*` 开关由 CMake 控制,哪个平台默认开哪些 → [第 9 章 §构建系统](09-ggml-backend.md)
- 用 `GGML_BACKEND_PATH` 环境变量挂树外后端 → [第 14 章 §环境变量](14-glossary-and-faq.md)

## 8. 走完这一步你脑子里应该多了什么

1. **后端是运行时发现的,不是编译期写死的**。`ggml_backend_load_all` 扫一遍动态库,有就装、没有就跳过 —— 一份二进制能适配 CPU-only 到多 GPU 的各种机器。
2. **有一张进程级全局注册表 `ggml_backend_registry`**,它是后端的唯一真相来源;之后所有"这台机器能用什么算力"的问题都查它。
3. **CPU 后端永远在场且排最后**,是一切硬件的兜底;GPU 后端是"能装上就用"的增益项。
4. **"找不到后端"是正常路径,不是错误**。优雅降级是设计目标,release 构建下连日志都不打。
5. 此刻还没有任何模型、张量、显存 —— 这一步纯粹是在**摸清算力家底**,为后面每一步的设备分派打底。

下一步:[步骤 02 —— 打开 GGUF 文件](tour-02-open-gguf.md)。
