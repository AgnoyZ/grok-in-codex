# 插件改进交付报告

## 0.8.0 后续改进（2026-09-19）

- 按用户最新要求，不保留旧 MCP 接口兼容：移除 `grok_status/result/cancel`、`grok_image/video`，由 `grok_job` 和 `grok_media` 直接替代。旧名称不再列出，调用时返回未知工具错误。
- 新增 `grok_artifacts action=discover|preview`：只读发现旧布局与拟议 `.grok/` 布局的产物，保留层级并报告迁移目标冲突、链接路径和不完整扫描。没有实际迁移或写入操作。
- 迁移设计见 [docs/artifact-migration.md](docs/artifact-migration.md)，涵盖路径引用、生产端切换、复制校验和回滚要求。现有产物输出路径继续使用旧布局。
- 同步更新工具测试、README、CHANGELOG 和四个 skills 中的调用示例；统一版本为 0.8.0。
- 验证：162/162 测试通过，0 跳过，约 7.44 秒；插件结构验证与 diff 空白检查通过。首次回归中一个原有测试在 Windows 临时目录清理时出现 `ENOTEMPTY`，未修改或跳过该测试，完整重跑通过。
- skills 通用校验器：使用 UTF-8 后仍不接受仓库原有的 `user-invocable` frontmatter 字段；该字段并非本次引入，保留既有调用策略，因此不能声称通用 skills 校验通过。

以下为 0.7.0 的历史交付记录。

日期：2026-09-19。目标版本：0.7.0。

## Phase 0：修改前核查

基线 `npm test`：137/137 通过，Node 测试计时 3302 ms。本机 Windows 沙箱第一次运行遇到
`spawn EPERM`；获得授权在沙箱外运行后全部通过，不属于用例失败。
下面的行号引用修改前源码；后续新增函数的位置以当前文件为准。

| 问题 | 修改前事实与位置 |
| --- | --- |
| a. cwd | 所有 MCP 工具均接受 cwd；缺失时使用 `process.cwd()`，已检查路径存在且是目录，但没有插件安装目录防护。`plugins/grok/mcp/server.mjs:402`、`:730`。Companion 通常再解析 Git 根目录，见 `plugins/grok/scripts/lib/workspace.mjs:3`。 |
| b. 写互斥 | `createJobShell` 建立记录，`runOrBackground` 直接启动，无工作区写锁。`plugins/grok/scripts/grok-companion.mjs:471`、`:516`。 |
| c. 存活 | Reaper 仅通过 PID 和 `process.kill(pid, 0)` 检查。完整结果待调和，缺失或损坏结果判失败。`plugins/grok/scripts/lib/jobs.mjs:405`、`plugins/grok/scripts/lib/process.mjs:51`。 |
| d. 清理与超时 | 状态索引最多保留 50 项，但未清理磁盘 job 文件；后台没有墙钟超时。实际 job 为平铺文件，并非每个 job 一个目录。`plugins/grok/scripts/lib/jobs.mjs:154`、`:204`，`plugins/grok/scripts/lib/grok.mjs:756`。 |
| e. 输出长度 | `commandResult` 直接输出完整 job 或渲染文本，没有长度限制。`plugins/grok/scripts/grok-companion.mjs:1694`。 |
| f. Rescue 权限 | 默认可写并使用 `--always-approve`，没有默认写模式黑名单。只读黑名单为 `run_terminal_cmd,search_replace,write_file,edit_file`；媒体模式为 `run_terminal_cmd,write_file,edit_file,search_replace`。已有 worktree flag 转发，没有发现源码层面的阻断，真实 CLI 隔离效果未验证。`plugins/grok/scripts/grok-companion.mjs:717`、`plugins/grok/scripts/lib/grok.mjs:13`、`:177`、`:232`。 |
| g. Setup | 使用 `grok version`、版本下限比较、`models` 鉴权与 `doctor`；没有 help 能力探测。`plugins/grok/scripts/lib/grok.mjs:47`、`plugins/grok/scripts/grok-companion.mjs:579`。 |

源码差异的处理：marketplace 使用顶层 `version` 和插件 entry `version`，没有 `metadata` 对象；
脚本更新实际字段，并兼容未来已有的 `metadata.version`。初始插件清单还带有
`+codex.20260919034845` 后缀，与 package/marketplace 的 0.6.0 不一致，现已统一。
本次修改仓库源文件，没有执行已安装插件的 cachebuster/重新安装流程。

## 任务完成情况

本次以一组可审阅的本地修改交付，未按附件创建十二个分支、PR，也未自动提交、推送、打 tag 或创建 Release。
附件是功能与验收参考，不视为单独授予外部发布权限。各任务共用最终完整回归结果，未声称每个中间步骤都通过测试。

| 任务 | 状态 | 修改文件 | 验证 |
| --- | --- | --- | --- |
| T1 | 配置完成；首次远端运行待验证 | `.github/workflows/test.yml` | push/PR，Node 18.18/20/22 × ubuntu/macos/windows，无 lockfile 使用 npm install，无真实 Grok 依赖。只在本机运行了测试，不能声称九组合已通过。 |
| T2 | 完成 | `scripts/bump-version.mjs`、`package.json`、两处插件元数据、`tests/improvements.test.mjs`、MCP 版本读取、README | `T2 all release version fields are consistent`；`T2 bump repairs version drift and rejects invalid versions without mutation` 在临时副本故意破坏版本、确认断言失败，再用脚本修复。 |
| T3 | 完成；省略可选 roots | `plugins/grok/mcp/server.mjs`、测试、README、CHANGELOG | `T3 missing cwd in plugin is refused for every write tool; read-only calls retain fallback`。已有目录检查复用并改进报错；增加纯路径判断。手写 MCP transport 没有 roots 请求机制，未增加依赖。 |
| T4 | 完成 | `lib/locks.mjs`、`grok-companion.mjs`、`lib/grok.mjs`、`lib/jobs.mjs`、测试、文档 | 同 cwd 拒绝、不同 cwd 独立、真实第二进程竞争、只读 worker 与 writer 共存、陈旧锁接管、结束释放、取消释放。锁路径为状态根下 `locks/sha1(realpath(cwd)).json`，使用 wx。 |
| T5 | 完成，行为变更 | `lib/rescue.mjs`、MCP 参数处理、companion、`lib/render.mjs`、测试、README、CHANGELOG | `T5 rescue default, explicit false, read-only, named worktree and environment precedence`，覆盖 direct/worktree/readOnly 及显式参数优先。保留 implement 原有 direct 默认。真实 CLI 端到端 worktree 验证仍待维护者运行。 |
| T6 | 完成 | `lib/process.mjs`、`lib/jobs.mjs`、后台元数据、测试、文档 | `T6 reused PID fails identity check; legacy jobs and unavailable identity keep PID behavior`。Linux 使用 stat starttime，Unix 使用 ps lstart，Windows 保守回退。取消也校验身份，避免在可识别时杀到复用 PID。 |
| T7 | 完成，按平铺状态布局实现 | `lib/maintenance.mjs`、companion、`lib/jobs.mjs`、测试、文档 | 过期、数量、运行中保护、持锁保护、24 小时节流、项目产物保护。只删除状态目录中的已知 job 文件，不信任记录中的外部路径。保留所有运行中索引记录。 |
| T8 | 完成 | MCP schemas/参数转发、companion、后台 wrapper、`lib/process.mjs`、测试、文档 | `T8 timeout precedence, zero and schema forwarding`；`T8 mock hanging background process times out, retains partial output, releases write lock and reconciles failed`。真实本地挂起 mock 子进程验证 failed、timeout、部分输出和锁释放。 |
| T9 | 完成 | `lib/result-limit.mjs`、MCP schema、companion、测试、文档 | `T9 result limit retains full body and artifact paths, supports zero and rejects invalid caps`。截断正文，附完整输出路径、总长度和产物路径；0 不截断。 |
| T10 | 完成 | `lib/maintenance.mjs`、setup、测试、文档 | `T10 artifact exclude is idempotent and non-Git directories are skipped`。通过 git rev-parse 获取实际 info/exclude 路径，不修改 .gitignore。 |
| T11 | 完成 | `lib/capabilities.mjs`、setup、`lib/render.mjs`、`lib/process.mjs`、测试、文档 | `T11 capability probes distinguish supported, unsupported and unknown mock help`。help 探测有 10 秒超时；help 列出并不等于运行时保证。 |
| T12 | 完成 | README、CHANGELOG、package/plugin/marketplace 版本、MCP transport 版本测试、本报告 | 版本脚本执行为 0.7.0；插件结构验证通过。发布、安装生效和真实 CLI 验收为后续维护操作。 |

测试汇总：154/154 通过，0 失败、0 跳过，耗时约 7.41 秒（Windows，Node v18.19.0）。
新增测试共 17 项，包括实际 companion JSON/Markdown 截断及锁冲突返回检查。
现有两项断言更新：实现工具显式保留写模式；MCP 版本与 manifest 一致。
插件结构检查：`plugin-creator/scripts/validate_plugin.py` 通过。
补充复查：前台 job 在创建时即记录 launcher PID/启动时间，避免并发状态查询误判死亡；
后台启动后将身份交接给 worker。`git diff --check` 通过。

## T11：实际 CLI 依赖

源码：`plugins/grok/scripts/lib/grok.mjs` 的 `buildGrokArgs`，以及 `lib/sessions.mjs`。

- 运行入口：`--prompt-file` / `-p`、`--output-format`（json / streaming-json）、`--json-schema`。
- 模型与会话：`-m`、`--effort`、`--cwd`、`-r`、`-c`、`--max-turns`、`--best-of-n`。
- 工作树：`--worktree`、`--worktree-ref`。
- 控制：`--sandbox`、`--permission-mode`、`--no-subagents`、`--agent`、`--agents`、`--allow`、`--deny`、`--disable-web-search`、`--fork-session`、`--experimental-memory`、`--no-memory`、`--no-plan`。
- 工具与提示：`--tools`（仅显式强制 allowlist 调用方）、`--disallowed-tools`、`--always-approve`、`--rules`、`--verbatim`。
- 子命令：`version`、`models`、`doctor`、`sessions list`、`sessions search`、`sessions export`；新增探测调用 `--help`。
- `check` 是 companion 的提示契约，**不**调用 Grok `--check`。Design/workflow/babysit 等通过任务提示驱动 Grok 工具，不是同名 CLI 子命令的硬编码调用。

所有已使用的 flag 纳入 help 报告；版本与功能的完整对应表没有真实环境证据，因此 README 标注未验证。

## 保留的限制与维护者后续操作

- GitHub Actions 首次九组合运行尚未触发；本机结果不能代替 Linux/macOS 与不同 Node 版本的结果。
- 尚未向真实 Grok 发起任务或验证登录，避免网络依赖与意外修改。维护者应在测试仓库确认所装 CLI 的 worktree 行为。
- Windows 无启动时间来源时仍使用 PID；未知启动时间采取保守存活策略。锁只约束本插件作业，不约束编辑器或其他代理。
- 保留期只清理已记录为终态的 job；没有结束状态的记录或损坏记录会保留。清理统计在 setup 中可见。
- 长文本 JSON 响应仅限制结果正文，原有 job 元数据字段继续保留；`maxChars` 不是整个序列化对象的字节上限。
- 已安装的插件缓存不会因仓库修改自动替换。验证完成后由维护者发布/重新安装，并开启新任务载入新版本。

## 初轮范围之外的建议与后续状态

- 合并 MCP 工具：已在 0.8.0 实现 `grok_job`、`grok_media`，按用户要求移除旧 MCP 工具名称，不保留转发层。
- 合并产物目录：0.8.0 提供只读发现与迁移预览。本次已将新产物默认输出切换为 `.grok/{plans,designs,workflows,docs,reviews,media}/`，同步 README、MCP 描述、skills 和 Git 本地忽略规则；按用户要求不迁移、不删除旧产物。`latest` 查找 `.grok/designs/`，旧设计文档仍可显式指定路径。
- 上游同步：维护 upstream remote 和定期比较流程；兼容性修复与 Codex 专属行为分别评估，避免直接覆盖分叉改动。

本次验证：164/164 测试通过，插件结构校验通过。三个已更新 skill 的通用校验器不接受原有 `user-invocable` frontmatter 字段；本次保留该调用策略字段，未修改。旧产物保留、统一目录写入和 `.grok/` 配置文件不被 Git 忽略均有测试覆盖。
