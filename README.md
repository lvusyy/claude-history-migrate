# claude-history-migrate

Migrate **Claude Code conversation history + project memory** across machines (or when relocating a project). After a new machine / OS reinstall / path change, makes your old chats show up again in `/resume`.

Single-file Node.js CLI, **zero dependencies**. **Dry-run by default** — nothing is written without `--apply`, and it **never touches your login** (`~/.claude/.credentials.json`, `~/.claude.json`).

```bash
# 1) extract your backup, then preview (writes nothing):
node claude-history-migrate.mjs --source "/path/to/.claude/projects"
# 2) apply (use --map if the project moved to a new path):
node claude-history-migrate.mjs --source "/path/to/.claude/projects" --apply
```

It fixes the four traps that silently break a manual restore:

1. **Dir encoding** — history lives at `~/.claude/projects/<path-with-every-non-alnum-char-as-dash>` (underscores and drive-letter case included).
2. **Path remap** — re-encodes the dir for the new path and rewrites the internal `cwd` fields.
3. **`entrypoint` filter** ⚠️ — `/resume` hides sessions whose entrypoint is `sdk-ts`/`sdk-cli`/`sdk-py` (anything created via the Agent SDK or workflow tools like maestro/ccw). The data is fine and `claude --resume <id>` works, but the picker shows nothing. This rewrites them to `cli`.
4. **Auth safety** — only the destination `projects/` dir is written.

---

> **中文说明 / Chinese docs below.**

跨机器迁移 Claude Code 的**对话历史 + 项目记忆**。换机器、重装系统、或把项目挪到新路径后，让 `/resume` 重新加载出以前的历史。

> 纯 Node.js 单文件，无第三方依赖（Claude Code 自带 Node 即可运行）。**默认 dry-run，不加 `--apply` 不写任何文件。全程不碰登录认证。**

## 背景：Claude 把历史存哪了

每个项目的历史 + 记忆存在：

```
~/.claude/projects/<编码后的项目路径>/
    <sessionId>.jsonl          ← 可恢复的对话
    <sessionId>/subagents/...  ← 子代理
    memory/                    ← 项目记忆
```

**编码规则**：项目绝对路径里**每个非字母数字字符都替换成 `-`**（大小写保留）：

```
D:\tmp\my_app   ->  D--tmp-my-app      (注意：下划线 _ 也变成 -)
d:\Code\app     ->  d--Code-app        (盘符大小写敏感)
```

迁移失败几乎都栽在以下 4 个坑，本工具逐一处理：

| 坑 | 现象 | 工具处理 |
|---|---|---|
| **目录名编码不对** | 打开项目历史为空 | 按新路径重新计算编码目录名（含下划线/盘符大小写陷阱） |
| **路径变了没改 cwd** | 恢复后工作目录错乱 | 路径前缀重映射，精确改写 jsonl 内 `cwd` 字段 |
| **entrypoint 被隐藏** ⚠️ | `/resume` 列表全空，但按 ID 能恢复 | 把 `sdk-ts/sdk-cli/sdk-py` 改成 `cli` |
| **覆盖了认证** | 登录失效 | 只写目标 projects 目录，**永不碰** `.credentials.json` / `.claude.json` |

> ⚠️ **第 3 个坑最隐蔽**：用 maestro / ccw / Agent SDK 等工具跑出来的会话，`entrypoint` 是 `sdk-ts`，而 `/resume` 选择器**故意只显示 `cli` 交互式会话**。所以历史明明在、按 ID `--resume <id>` 也能恢复，列表却空空如也。

## 用法

**第一步：解压备份。** 工具读的是一个 `projects` 目录，先把备份解出来：

```bash
# 你的备份（tar/zip）里通常是 .claude/ 整个目录
tar -xf claude-backup.tar -C /some/extract/dir   # 得到 /some/extract/dir/.claude/projects
```

**第二步：先 dry-run 看计划（不写任何东西）：**

```bash
node claude-history-migrate.mjs --source "/some/extract/dir/.claude/projects"
```

输出一张表：每个源项目 → 目标编码目录、会话数、新路径是否存在、是否需要重映射。

**第三步：确认无误后 `--apply` 执行：**

```bash
node claude-history-migrate.mjs --source "/some/extract/dir/.claude/projects" --apply
```

**第四步**：在任意迁移过的项目里打开 Claude，`/resume`，历史就回来了。

## 路径变了怎么办（重映射）

如果项目在新机器上换了位置（或旧用户名不同），用 `--map "旧前缀=新前缀"`（可重复，最长前缀优先）：

```bash
node claude-history-migrate.mjs \
  --source "/extract/.claude/projects" \
  --map "D:\codeBase=D:\tmp" \
  --map "C:\Users\OldUser=C:\Users\NewUser" \
  --apply
```

工具会自动从会话内 `cwd` 反推每个项目的**真实旧路径**，套用映射得到新路径，重算编码目录名，并改写 `cwd`。

## 选项

| 选项 | 说明 |
|---|---|
| `--source <dir>` | **必填**。旧机器的 `projects` 目录（或含它的父目录 / 解压出的 `.claude/projects`）。 |
| `--dest <dir>` | 目标 projects 目录。默认 `~/.claude/projects`。 |
| `--map "<old>=<new>"` | 路径前缀重映射，可重复。 |
| `--only <a,b,...>` | 只处理指定的源项目目录名。 |
| `--require-exists` | 跳过新路径在本机不存在的项目（只迁你实际有的）。 |
| `--no-entrypoint-fix` | 不改 entrypoint（不推荐，会导致 SDK/工作流会话在 `/resume` 里不显示）。 |
| `--overwrite` | 覆盖目标已存在的同名会话文件（默认保留、只补缺失，保护本机新会话）。 |
| `--apply` | 真正执行（不加则只是 dry-run 预览）。 |
| `-h, --help` | 帮助。 |

## 安全说明

- 只写 `--dest` 下的 `<编码目录>/`，其余一律不动。
- **永不**修改 `~/.claude/.credentials.json` 和 `~/.claude.json`（你的登录态安全）。
- 默认 dry-run；默认不覆盖已存在文件（合并式，保护本机已有历史）。
- 原始备份不会被改动，随时可重来。

## 常见问题

**Q：按 ID `claude --resume <id>` 能恢复，但 `/resume` 列表里看不到？**
A：典型的 entrypoint 过滤。确认运行时**没加** `--no-entrypoint-fix`，重跑一次即可。

**Q：历史完全加载不出（不是列表问题，是真的空）？**
A：多半是目录编码名和当前打开路径对不上。dry-run 表里核对"目标编码目录"是否等于 `当前项目路径` 的编码（下划线→`-`、盘符大小写）。还要注意别用**网络盘**路径打开（网络盘 `Z:\x` 与本地 `D:\tmp\x` 编码不同，即使内容一样）。

**Q：会丢数据吗？**
A：不会。默认 dry-run + 不覆盖 + 不碰认证 + 不改原备份。

## 排错：拿到确切原因

如果列表还有问题，让 Claude 自己说原因：

```bash
claude --debug-file ./resume-debug.log
# 进去后执行 /resume 再退出，然后看日志：
#   grep -E "filtered from|Skipping|found .* session|visible" resume-debug.log
```

日志会逐条打印每个会话被过滤/跳过的确切原因（`entrypoint=...`、`invalid timestamp`、`No valid conversation chain` 等）。
