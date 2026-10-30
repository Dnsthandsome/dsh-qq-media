# dsh-qq-media

给 **DeepSeek Harness** 的 QQ 机器人（[`dsh-qq-moony`](https://www.npmjs.com/package/dsh-qq-moony)）补上**语音 / 图片 / 视频 / 文件**出口。

`dsh-qq-moony` 本身只能发文字和表情包。这个插件给它加了 5 个工具，让它真的能「发一条语音过来」「把这张图发我」「这段视频发你」。

---

## 功能

| 工具 | 作用 |
|---|---|
| `qq_send_voice` | 合成语音条并发送（默认微软晓伊少女音，1~2 秒出结果） |
| `qq_send_image` | 发图片，本机路径或网络 URL 都行（走 QQ 图片消息，不是文字链接） |
| `qq_send_video` | 发视频文件 |
| `qq_send_file` | 发任意文件（可自定义显示名） |
| `qq_media_check` | 自检：OneBot 通不通、登录哪个号、TTS 各引擎可用不可用 |

另有一个版本探针路由 `GET /api/qq-media/ping`，返回当前宿主里跑的版本号 —— 改完插件代码想确认有没有真的重载，打这个接口就行。

## 语音引擎

三种，按优先级自动降级：

| 引擎 | 说明 |
|---|---|
| **edge**（默认） | 微软在线语音（edge-tts）。免费、无 key、1~2 秒出结果，不占显卡。音色可换、音调语速可调 |
| **breeze** | 本机跑 [Breeze TTS 2](https://huggingface.co/BreezeBlue/Breeze-TTS-2)，用自然语言描述音色（"一个二十出头的女生，声音偏软偏轻……"），效果接近真人。**但很慢** —— 8GB 显卡上一条 5 秒音频要一两分钟，不适合聊天 |
| **sapi** | Windows 自带 System.Speech。难听但一定在，只作兜底 |

**默认只走 edge，失败就报错，不会偷偷换成难听的 SAPI。** 想允许降级到 SAPI，在配置里加 `"allowSapiFallback": true`。

edge-tts 偶尔会抽风（403 / 空音频），插件内置 3 次重试（间隔 400/1200ms）。另外发语音前会自动**清洗文本**：emoji、`*_`#>`、控制符全去掉 —— 这些东西会让 edge-tts 整句哑掉。

### 内置音色

```
zh-CN-XiaoyiNeural        晓伊，少女，活泼
zh-CN-XiaoxiaoNeural      晓晓，温柔
zh-CN-shaanxi-XiaoniNeural 晓妮，明亮（陕西口音）
zh-CN-liaoning-XiaobeiNeural 晓北（东北口音）
```

音调 `pitch` 用 `+18Hz` 这种写法（不写正负号插件会自动补 `+`），语速 `rate` 用 `+3%` / `-5%`。

## 安装

> 尚未发布到 npm，直接从 GitHub 装。

```bash
dsh plugin --profile desktop add github:Dnsthandsome/dsh-qq-media
```

或者本地打包：

```bash
git clone https://github.com/Dnsthandsome/dsh-qq-media.git
cd dsh-qq-media
pnpm pack --pack-destination dist-pkgs
dsh plugin --profile desktop add dist-pkgs/dsh-qq-media-0.2.2.tgz
```

## 前置条件

1. **装了 `dsh-qq-moony`**，并且它的 `config.json` 里配好了 `baseUrl` 和 `token`（本插件复用这份连接配置，不单独存凭据）
2. **Python 环境装了 edge-tts**（默认引擎要用）：

```bash
pip install edge-tts
```

然后在 `qq-media/config.json` 里把 `python` 指向那个环境的解释器。

> 本插件不会自动装 Python，也不会自己找解释器 —— 路径必须给。Windows 上建议用独立 venv，避免污染全局。

3. （可选）想用 breeze 引擎，需要额外部署 [Breeze TTS 2](https://github.com/breezeblue-ai/breeze-tts)，并在配置里填 `serverDir` / `modelDir` / `apiUrl`。不配也能用，`qq_media_check` 会报「没在跑」。

## 配置

`<DSH_HOME>/qq-media/config.json`（**每次调用都现读磁盘**，改完立即生效，不用重启）：

```json
{
  "engine": "edge",
  "edgeVoice": "zh-CN-XiaoyiNeural",
  "edgePitch": "+18Hz",
  "edgeRate": "+3%",
  "python": "D:\\edge-tts\\.venv\\Scripts\\python.exe",
  "allowSapiFallback": false,

  "breezeEngine": "breeze",
  "apiUrl": "http://127.0.0.1:7861",
  "instruction": "一个二十出头的女生，声音偏软偏轻，说话慢一点，语气亲近，像私下里聊天。",
  "cfgScale": 2,
  "serverDir": "D:\\breeze-tts\\src\\breezeblue-ai-breeze-tts-6eba901",
  "modelDir": "D:\\breeze-tts\\models\\Breeze-TTS-2",
  "autoStart": false
}
```

连接配置从 `<DSH_HOME>/qq-moony/config.json` 读 `baseUrl`（默认 `http://127.0.0.1:3000`）和 `token`。

## 工具参数

```
qq_send_voice
  to      必填，QQ 号；发群写 "group:群号"
  text    必填，要念的话（纯口语，别带 Markdown）
  voice   可选，音色 id
  pitch   可选，如 "+18Hz"
  rate    可选，如 "+3%"
  engine  可选，edge | breeze | sapi

qq_send_image   to, source（本地路径或 http(s) 链接）
qq_send_video   to, path
qq_send_file    to, path, name（可选显示名）
qq_media_check  无参数
```

`to` 的写法很宽松：`1245661522`、`group:123456`、`群 123456` 都认。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/qq-media/ping` | 版本探针：`{version, engine, edgeVoice, pid}` |

## 踩过的坑（写在代码里了）

- **edge-tts 对 emoji 会整句哑掉** → 发之前先 `清洗文本()`
- **edge-tts 偶尔 403/空音频** → 3 次重试，别一次失败就降级
- **SAPI 太难看** → 默认不降级，宁可报错让它重说一遍
- **宿主不重载插件代码** → 改完要 `dsh plugin remove` 再 `add`，或者重启宿主；`/api/qq-media/ping` 的版本号就是用来验证这个的
- **PowerShell `Set-Content` 会把中文 JSON 写坏**（UTF-8 读成 GBK）→ 改配置请用编辑器或 node 脚本

## 配套

- [`dsh-qq-moony`](https://www.npmjs.com/package/dsh-qq-moony) —— 机器人本体（OneBot / NapCat）
- `dsh-qq-persona` —— 人格切换（切换时按预设改写本插件的音色配置）
- `dsh-qq-memory` —— 记忆管理面板

## License

MIT
