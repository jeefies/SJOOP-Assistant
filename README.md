# SJOOP Assistant (同济程序设计/OOP 课程作业助手)

专为同济大学程序设计 / 面向对象程序设计 (OOP) 课程（SJ 大人的严格标准）量身定制的 VS Code 侧边栏扩展插件。

---

## 🌟 核心特性

### 1. 三编译器深度支持与自动定位
- **Visual Studio 2026 MSVC**：
  - 自动通过 `vswhere.exe` 探测 Visual Studio 安装目录及 `vcvars64.bat`。
  - 预设还原 VS IDE 原生 Debug 编译参数（`/std:c++20 /EHsc /permissive- /W3 /MDd /Od` 等），解决裸调用 `cl.exe` 导致的 C4530 异常警告与语言标准不匹配问题。
  - 绑定 `/source-charset:gb18030 /execution-charset:gb18030`，彻底免疫 Windows 区域语言设置差异。
- **MinGW g++ (小熊猫 C++ / RedPanda-CPP)**：
  - 自动探测 RedPanda-CPP 及系统中的 `g++.exe`。
  - 默认注入 `-finput-charset=GB18030 -fexec-charset=GB18030 -std=c++20 -Wall`，杜绝 GBK 源码中的中文注释/字符串导致 GCC 报错。
- **Linux C++ (校内华为鲲鹏 920 服务器)**：
  - 针对 `10.80.42.230:22`，支持 `u{学号}` 自动化 SSH2 + SFTP 连接。
  - 必须在用户设置中指定课程专用私钥，并固定可信的服务器主机 SHA256 指纹；加密私钥通过 VS Code 密码输入框输入口令，仅用于当次连接。
  - 自动上传源文件至 `~/sjoop_tmp/{homework}/`，在 Kunpeng 920 (ARM64, 纯64位, 256MB 内存限额) 上编译并运行。
  - 内置网络连通性探测，在校外时友好提示连接同济 VPN。

### 2. GB18030 / GBK 编码全生命周期守护
- **系统代码页探测**：自动识别本机 Windows 代码页（如 CP936 vs CP65001 UTF-8）。
- **实时编码检测**：打开或保存 C/C++ 源文件时，实时检测是否为 UTF-8（含 BOM 或无 BOM）。
- **无损转换**：若误存为 UTF-8，面板与状态栏均会发出高亮警告，并提供转为符合课程红线标准的 **GB18030** 编码。
- **I/O 字节流守卫**：测试数据 stdin 写入与 stdout 接收均以 GB18030 编解码。

### 3. 单文件与多文件灵活模式
- **单文件模式**：自动跟踪当前活动编辑器文件（如 `hw1.cpp`）。
- **多文件模式**：支持自由切换并添加联合编译的 `.cpp` / `.h` 文件（例如大作业 `4-b16-main.cpp` + `4-b16-sub1.cpp` 等）。

### 4. OI 风格测试用例与严格逐字节比对
- **隐式持久化存储**：测试数据保存在工作区 `.sjoop/tests/{文件名}.json`，不污染作业源代码目录与打包文件。
- **严格逐字节比对 (Strict Byte-for-Byte Diff)**：
  - 满足严格判题要求，不放过任何隐蔽的空白符或换行符问题。
  - 当比对失败 (WA) 时，提供精确到字节偏移 (Byte Offset) 的 Hex 与上下文对比视窗（例如直观显示 `\r\n` (0x0D 0x0A) 与 `\n` (0x0A) 的差异）。
- **测试结果矩阵**：一次点击，并行或分列展示 MSVC、MinGW、Linux 三编译器的判定状态（AC / WA / TLE / RE / CE）与耗时。

---

## ⚙️ 自由配置项 (`settings.json`)

所有编译器路径、编译 Flags、学号、网络设置均可自由配置与覆盖：

| 配置键 | 默认值 | 描述 |
| :--- | :--- | :--- |
| `sjoop.studentId` | `""` | 你的学号（SSH 用户名自动为 `u{学号}`） |
| `sjoop.encoding.targetCharset` | `"gb18030"` | 目标字符集（可选 `gb18030`, `gbk`, `utf-8`） |
| `sjoop.encoding.autoWarn` | `true` | 检测到非目标编码时自动弹窗警报 |
| `sjoop.msvc.autoDetect` | `true` | 是否自动探测 VS MSVC 安装路径 |
| `sjoop.msvc.vcvarsPath` | `""` | 手动指定 `vcvars64.bat` 或 `vcvarsall.bat` |
| `sjoop.msvc.flags` | 见 package.json | MSVC 编译参数 |
| `sjoop.mingw.autoDetect` | `true` | 是否自动探测 RedPanda g++ |
| `sjoop.mingw.gppPath` | `""` | 手动指定 `g++.exe` 路径 |
| `sjoop.mingw.flags` | `["-Wall", "-std=c++20", ...]` | MinGW 编译参数 |
| `sjoop.linux.host` | `"10.80.42.230"` | Linux 服务器 IP |
| `sjoop.linux.port` | `22` | Linux SSH 端口 |
| `sjoop.linux.privateKeyPath`| `""` | 在用户设置中明确指定 SSH 私钥路径；为空或无效时停止 |
| `sjoop.linux.hostKeyFingerprint` | `""` | 管理员提供并核对的服务器主机公钥 SHA256 指纹；必填 |
| `sjoop.judge.timeoutMs` | `5000` | 测试点超时时间限制 (ms) |
| `sjoop.judge.strictByteDiff`| `true` | 是否开启严格逐字节比对 |

---

## Linux SSH 安全配置与迁移

更新后不再自动搜索或回退到 `~/.ssh/id_ed25519` / `id_rsa`。请在 **VS Code 用户设置**中填写 `sjoop.linux.privateKeyPath`，优先使用只用于课程服务器的私钥。服务器地址、端口、私钥路径和主机指纹仅从用户设置或扩展默认值读取，项目中的 `.vscode/settings.json` 无法覆盖这些连接设置。

首次连接前，通过老师或服务器管理员等可信渠道取得服务器 **主机公钥**指纹，填写 `sjoop.linux.hostKeyFingerprint`，格式为 `SHA256:...`。这不是你的登录公钥指纹。管理员可在服务器上对实际使用的主机公钥运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`，或提供对应 RSA/ECDSA 主机公钥的指纹。不要仅将未验证的网络扫描结果当作可信指纹；服务器换钥或 SSH 协商选择其他主机密钥时，须重新核对后更新配置。没有配置指纹或指纹不匹配时，测试连接和远程编译都会停止。

加密私钥会在测试连接或 Linux 编译时弹出 VS Code 的密码输入框。口令不会保存到设置、工程 JSON、日志或侧栏状态；取消输入会停止本次操作，无需移除私钥的保护口令。

远程上传只接受工程范围内的 `.c`、`.cpp`、`.cc`、`.cxx`、`.h`、`.hpp`、`.hh`、`.hxx` 普通文件，并至少包含一个源文件。范围来自活动文件所属工作区；未打开文件夹时，使用最初打开源文件所在目录。多文件工程 JSON 不能扩大这个范围。工程外的路径、指向工程外的符号链接/目录联接、硬链接、其他文件类型和同名冲突会导致整次上传停止，不会被静默跳过。所选 SSH 私钥即使位于工程内且使用上述后缀，也禁止上传。需要上传其他目录的源码时，请将共同的工程目录作为 VS Code 工作区打开。

`sjoop.linux.flags` 的每个数组元素对应一个编译器参数，例如 `["-Wall", "-std=c++20"]`。路径、文件名和参数中的空格、引号或 shell 特殊符号会按字面值传递；不要把多个参数或 shell 命令写在同一个元素中。

本扩展的编译、运行及 SSH 操作要求受信任的工作区。以上检查限制正常功能的凭据使用和文件上传范围，扩展仍然需要用户对安装来源和运行的课程代码给予信任。

## 🚀 开发与调试

1. 安装依赖：
   ```bash
   npm install
   ```
2. 运行自动化测试：
   ```bash
   npm test
   ```
3. 构建打包：
   ```bash
   npm run compile
   ```
4. 在 VS Code 中按下 `F5` 即可启动“扩展开发宿主”窗口直接体验插件！
