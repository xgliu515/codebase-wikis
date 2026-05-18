# Trace 步骤 01 —— 命令行那几个参数，怎么变成一次推理任务？

## 1. 当前情境

进程刚启动。`main()` 拿到 `argc / argv`：

```
argv = { "./ds4", "-m", "DS4.gguf", "-p", "你好", "-n", "3" }
```

此刻什么都还没有：模型没加载，分词器不存在，后端没初始化。整个程序唯一拥有的，
就是这 7 个字符串。`main()` 在 `ds4_cli.c:1338`，第一件事就是把它们交给
`parse_options()`。

## 2. 问题

这一步要把**一串无结构的命令行字符串**，变成一份**结构化、带默认值、已校验**的
运行配置。后面每一个子系统——引擎、会话、采样器——都要从这份配置里取参数。

具体要解决三件事：

1. **缺省**：用户只给了 3 个参数，但引擎要知道上下文窗口多大、温度多少、用哪个
   后端、生成上限多少。没给的得有合理默认值。
2. **类型化**：`"3"` 是字符串，`n_predict` 需要的是 `int`；`"metal"` 要变成
   `DS4_BACKEND_METAL` 枚举。转换失败要当场报错，不能拖到推理中途。
3. **平台适配**：用户没写 `--backend`。在 MacBook 上应该自动选 Metal，在
   Linux + DGX Spark 上应该自动选 CUDA。

## 3. 朴素思路

最直接的做法：定义一个 `cli_config` 结构体，用 `getopt` 或一个 `for` 循环扫
`argv`，扫到 `-m` 就把下一个参数存进 `model_path`，扫到 `-n` 就 `atoi` 一下存进
`n_predict`。没扫到的字段……保持零值就行。

这思路本身没错，ds4 也确实就是一个 `for` 循环扫 `argv`。问题出在「没扫到的字段
保持零值」。

## 4. 为什么朴素思路会崩

「零值即默认」在推理引擎里是个陷阱：

- `ctx_size = 0` —— 会话会按 0 个 token 分配 KV 缓存，第一个 prompt token 就越界。
- `temperature = 0.0` —— 恰好是合法值（贪心解码），无法区分「用户要贪心」和
  「用户没指定」。ds4 里 `temperature > 0` 走采样、`== 0` 走 argmax，零值默认会
  让所有人都掉进贪心路径。
- `n_predict = 0` —— 一个 token 都不生成，命令直接空跑。
- `backend = 0` —— 枚举 0 是 `DS4_BACKEND_METAL`。在 Linux 上零值默认会让程序
  尝试加载根本不存在的 Metal 框架。

也就是说：**结构体的零值，几乎没有一个是合理的运行默认值**。靠 `{0}` 初始化必崩。

## 5. DwarfStar 4 的做法

`parse_options()` 不用零值初始化，而是用一份**显式的默认配置**做起点，再让命令行
参数**覆盖**它（`ds4_cli.c:1190`）：

```c
cli_config c = {
    .engine = {
        .model_path = "ds4flash.gguf",
        .backend = default_backend(),     // 按平台选，不是 0
        .mtp_draft_tokens = 1,
    },
    .gen = {
        .system = "You are a helpful assistant",
        .n_predict = 50000,
        .ctx_size = 32768,
        .temperature = DS4_DEFAULT_TEMPERATURE,   // 1.0f
        .min_p = DS4_DEFAULT_MIN_P,               // 0.05f
        .think_mode = DS4_THINK_HIGH,
    },
};
```

关键点：

- **默认值是有意义的运行值**，不是零。`ctx_size` 默认 32768，`temperature` 默认
  `1.0f`，`min_p` 默认 `0.05f`（这几个常量定义在公共头 `ds4.h:48` 一带）。
- **后端是函数算出来的**，不是常量。`default_backend()`（`ds4_cli.c:236`）用编译期
  宏决定：`__APPLE__` → Metal，否则 → CUDA，`DS4_NO_GPU` → CPU。所以
  `./ds4 -m DS4.gguf -p "你好" -n 3` 在 MacBook 上自动是 Metal。

然后是覆盖循环（`ds4_cli.c:1211` 起），逐个 `argv` 比对：

```c
for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (!strcmp(arg, "-m") || !strcmp(arg, "--model")) {
        c.engine.model_path = need_arg(&i, argc, argv, arg);
    } else if (!strcmp(arg, "-n") || !strcmp(arg, "--tokens")) {
        c.gen.n_predict = parse_int(need_arg(&i, argc, argv, arg), arg);
    } else if (!strcmp(arg, "-p") || !strcmp(arg, "--prompt")) {
        c.gen.prompt = need_arg(&i, argc, argv, arg);
    }
    /* ... --backend / --temp / --think / ... */
}
```

`parse_int` / `parse_float_range`（`ds4_cli.c:197` 一带）做类型转换**并校验**：
解析失败或越界直接 `exit(2)`——「类型化」和「当场报错」一起完成。

对我们这条命令，循环结束后 `cli_config` 是：

```
engine.model_path = "DS4.gguf"     engine.backend    = DS4_BACKEND_METAL (Apple)
gen.prompt        = "你好"          gen.n_predict     = 3
gen.ctx_size      = 32768          gen.temperature   = 1.0f
gen.system        = "You are a helpful assistant"
```

`temperature = 1.0f > 0`——所以后面 `run_generation()`（`ds4_cli.c:717`）会走
**采样**路径 `run_sampled_generation()`，而不是 argmax。这是步骤 14 的伏笔。

`main()` 拿回 `cfg` 后还做一件事：`log_context_memory()` 打印这次 `ctx_size`
要占多少 KV 缓存内存，让你在加载几十 GiB 模型**之前**就知道会不会爆内存。

## 6. 代码位置

按阅读顺序：

- 入口：`ds4_cli.c:1338` —— `main()`，第一行就是 `parse_options()`。
- 核心：`ds4_cli.c:1190` —— `parse_options()`，默认配置 + 覆盖循环。
- 默认后端：`ds4_cli.c:236` —— `default_backend()`，编译期平台分支。
- 类型转换：`ds4_cli.c:197`、`ds4_cli.c:217` —— `parse_int` / `parse_float_range`。
- 后端枚举：`ds4_cli.c:227` —— `parse_backend()`。
- 分流：`ds4_cli.c:717` —— `run_generation()`，按 `temperature` 选采样 / argmax。

## 7. 分支与延伸

- 这条 trace 走的是 CLI 入口。换成 HTTP 服务器入口（`ds4-server`），配置来自
  请求 JSON 而非 `argv` → [第 13 章 HTTP 服务器与 Agent API](13-http-server-api.md)
- `cli_config` 里的 `ctx_size` 怎么换算成 KV 缓存内存 →
  [第 7 章 §KV 缓存内存估算](07-kv-cache.md)
- 三大后端的差异、`default_backend()` 的编译期选择 →
  [第 1 章 §三大后端](01-architecture-overview.md)
- `--think` / `--think-max` 怎么影响 prompt 渲染 →
  [第 5 章 §thinking 模式](05-tokenizer-chat.md)
- `--mtp` / `--mtp-draft` 开启推测解码后这条 trace 会怎么变 →
  [第 12 章 推测解码与 MTP](12-speculative-mtp.md)

## 8. 走完这一步你脑子里应该多了什么

1. ds4 的配置默认值是**显式写出的运行值**，绝不靠结构体零值——因为推理引擎里
   几乎没有一个字段的零值是合理默认。
2. `--backend` 不给时，后端由 `default_backend()` 在**编译期**按平台决定：
   Apple → Metal，Linux → CUDA。
3. 命令行参数解析时就完成类型转换与范围校验，错误**当场 `exit`**，不会带病
   进入加载阶段。
4. `temperature` 的值（默认 `1.0f`）决定后面走采样还是 argmax 路径——配置阶段
   就埋下了执行路径的分叉。
5. 加载几十 GiB 模型之前，`log_context_memory()` 已经把 KV 缓存内存预算打出来了。
