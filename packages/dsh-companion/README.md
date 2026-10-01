# dsh-companion

一个面向长期自用的本地优先 AI 陪伴核心。它作为独立的 Cordis/DeepSeek Harness 插件运行，由 `dsh-im` 提供可信微信或 QQ 私聊路由；计划、关系状态、画像记忆和投递结果保存在本地 SQLite 中。

## 已实现

- 按所有者时区持久调度早安、兴趣话题和晚安；重启后可恢复，DST 与跨日窗口安全。
- `gentle`、`natural`、`clingy` 三种关系模式；根据回复率、回复延迟和连续未回复次数自动热络或安静。
- clingy 模式支持一次有边界的追发；用户回复后自动取消，且不会无限连发。
- 专用自然对话系统提示：短句、多气泡、引导倾诉，但禁止威胁、自伤暗示、贬低和排他性依赖。
- 从聊天中提炼有证据、可过期、可遗忘的用户画像；原始入站文本不会直接复制进 companion 数据库。
- 联网话题只使用经过隐私投影和保守改写的查询，保存 HTTPS 来源并去重。
- 可选本地表情包清单，支持语义标签、渠道能力检查、路径安全、大小限制和发送冷却；素材异常时只降级为文字。
- 微信与 QQ 均只为精确配置的所有者建立主动路由；通配符所有者不会获得主动发送能力。
- 逐气泡幂等投递、未知结果不重试、明确 429 最多安全延后一次。

## 最小配置

同一个 Host 中启用 `dsh-im` 和本插件后，Host 会自动提供专用 Harness 会话能力。要启动常驻调度器：

```json
{
  "worker": { "enabled": true, "intervalMs": 60000 },
  "systemPrompt": { "enabled": true }
}
```

也可以改用 OpenAI 兼容接口生成主动消息与提炼记忆。密钥由环境变量读取，不写入配置或日志：

```json
{
  "generator": {
    "type": "openai-compatible",
    "baseUrl": "https://api.example.com/v1",
    "model": "your-model",
    "apiKeyEnv": "COMPANION_API_KEY"
  },
  "memoryExtractor": {
    "type": "openai-compatible",
    "baseUrl": "https://api.example.com/v1",
    "model": "your-model",
    "apiKeyEnv": "COMPANION_API_KEY"
  }
}
```

### 表情包导入

首次初始化会创建 `inbox/开心`、`难过`、`假装生气`、`安慰`、`惊讶`、`调侃` 六个分类文件夹：

```powershell
node .\packages\dsh-companion\src\cli.mjs stickers init
```

把 PNG、JPG、GIF 或 WebP 图片放进对应中文文件夹。配置 `autoImport: true` 后，只需重启 DSH，插件会在启动时自动导入。也可以手动运行：

```powershell
node .\packages\dsh-companion\src\cli.mjs stickers import "$env:USERPROFILE\.dsh\integrations\dsh-companion\stickers\inbox"
```

导入器会按内容哈希去重、跳过未分类或超过 10 MB 的图片，并生成 `stickers.json`。如果是在 DSH 运行期间手动导入，仍需重启一次来重新加载清单。默认同一种情绪随机选择，单张素材 24 小时内不会重复发送。

也可以从 ChineseBQB 的公开数据源限速采集一批带文件名语义标注的素材：

```powershell
node .\packages\dsh-companion\src\cli.mjs stickers collect --limit 72
```

采集结果只写入本机 `.dsh` 数据目录，同时生成 `collection-sources.json` 记录来源。不要把个人素材目录随插件代码一起开源。

选图不再只按六种情绪硬分类：模型会生成一句可替代表达，目录根据图片配文、关键词、近义概念和情绪做混合召回，再从高分候选中随机选择。这个接口后续可以继续接入专用图文 embedding；当前实现不需要额外下载大型模型。

启用表情包实时采集后，可在微信或 QQ 私聊中发送 `/bqb` 开始收集，连续发送图片，发送 `/bqb_end` 结束。采集会在进程内立即更新目录，图片不进入 Harness 普通会话；文字只会得到继续发图的提示。图片限制为 10 MB，支持 PNG/JPEG/GIF/WebP，并按内容 SHA-256 去重。

也可以显式指定其他目录：

```json
{
  "stickers": {
    "enabled": true,
    "rootDir": "D:/companion-stickers",
    "manifestPath": "D:/companion-stickers/stickers.json",
    "autoImport": true,
    "cooldownMs": 86400000,
    "capture": { "enabled": true }
  }
}
```

清单格式见 `stickers.example.json`。只使用自己拥有或获准使用的素材；GIF 是否保持动画取决于具体聊天渠道。

## 数据与控制

默认数据库位于 `${DSH_HOME:-~/.dsh}/integrations/dsh-companion/companion.sqlite3`。常用命令：

```text
dsh-companion proactive status OWNER
dsh-companion proactive pause OWNER
dsh-companion proactive resume OWNER
dsh-companion stickers init
dsh-companion stickers import PATH
dsh-companion memory list OWNER
dsh-companion memory export OWNER
dsh-companion memory forget OWNER MEMORY_ID --yes
dsh-companion memory erase OWNER MEMORY_ID --yes
dsh-companion memory clear OWNER --yes
```

遗忘和删除只影响本地 companion 数据，不能撤回已经发送的 IM 内容，也不会改写外部提供商数据或已有备份。

## 开发

```sh
npm run check:companion
```

公开入口包括核心、调度器、生成器、话题、表情包、记忆提炼器和系统提示模块，详见 `package.json` 的 `exports`。
