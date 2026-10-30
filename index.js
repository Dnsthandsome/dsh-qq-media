/**
 * dsh-qq-media —— 给 dsh-qq-moony 补上「语音 / 视频 / 文件 / 图片」出口。
 *
 * 语音两种引擎：
 *  - breeze：本机跑 Breeze TTS 2（D:\breeze-tts），自然语言描述音色，效果接近真人；
 *            走它自带的 FastAPI 流式接口（默认 127.0.0.1:7861），拿到 24kHz PCM16 再包成 wav。
 *  - sapi：Windows 自带 System.Speech，兜底用（难听但一定在）。
 *
 * 连接配置复用 qq-moony 的 <DSH_HOME>/qq-moony/config.json；TTS 配置在 <DSH_HOME>/qq-media/config.json。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const name = 'qq-media';
export const inject = ['tools'];

const 超时 = 60_000;
/** 版本号：界面上 /api/qq-media/ping 能查到，用来确认跑的是不是新代码 */
const 版本 = '0.2.2';

/** edge-tts 遇到表情、Markdown、控制符会整句哑掉，先把它们洗掉再说 */
function 清洗文本(原文) {
  return String(原文 ?? '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu, '')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TTS默认 = {
  engine: 'edge',
  // edge：微软在线语音，免费、1~2 秒出结果，默认用这个
  edgeVoice: 'zh-CN-XiaoyiNeural',
  edgePitch: '+18Hz',
  edgeRate: '+3%',
  python: 'D:\\breeze-tts\\.venv\\Scripts\\python.exe',
  // breeze：本机 Breeze TTS 2（自然语言捏音色，效果好但 8GB 显卡上一个来回要一两分钟）
  breezeEngine: 'breeze',
  apiUrl: 'http://127.0.0.1:7861',
  instruction: '一个二十出头的女生，声音偏软偏轻，说话慢一点，语气亲近，像私下里聊天。',
  cfgScale: 2,
  serverDir: 'D:\\breeze-tts\\src\\breezeblue-ai-breeze-tts-6eba901',
  modelDir: 'D:\\breeze-tts\\models\\Breeze-TTS-2',
  autoStart: false,
};

function 家目录() {
  const 根 = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(根, 'qq-moony');
}

function 读配置() {
  const 文件 = join(家目录(), 'config.json');
  if (!existsSync(文件)) return {};
  try {
    return JSON.parse(readFileSync(文件, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function 连接配置() {
  const c = 读配置();
  return {
    baseUrl: String(c.baseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: String(c.token || ''),
  };
}

function 媒体配置() {
  const 根 = process.env.DSH_HOME || join(homedir(), '.dsh');
  const 文件 = join(根, 'qq-media', 'config.json');
  let 磁盘 = {};
  try {
    if (existsSync(文件)) 磁盘 = JSON.parse(readFileSync(文件, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    /* 配坏了就当没有 */
  }
  return { ...TTS默认, ...磁盘, 文件 };
}

async function 调接口(动作, 负载) {
  const { baseUrl, token } = 连接配置();
  const 响应 = await fetch(`${baseUrl}/${动作}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(负载),
    signal: AbortSignal.timeout(超时),
  });
  const 文本 = await 响应.text();
  let 数据;
  try {
    数据 = JSON.parse(文本);
  } catch {
    throw new Error(`NapCat 返回的不是 JSON（HTTP ${响应.status}）：${文本.slice(0, 200)}`);
  }
  if (数据.retcode !== 0 || 数据.status === 'failed') {
    throw new Error(`NapCat 拒绝：${数据.wording || 数据.message || JSON.stringify(数据).slice(0, 200)}`);
  }
  return 数据.data ?? {};
}

function 解析目标(to) {
  const 原 = String(to ?? '').trim();
  const 群 = /^(group[:：/\s]|群)/i.test(原);
  const 数字 = 原.replace(/[^0-9]/g, '');
  if (!数字) throw new Error(`认不出目标 "${原}"，请给 QQ 号（群的话写 "group:群号"）`);
  return 群
    ? { 动作: 'send_group_msg', 字段: 'group_id', 号: Number(数字) }
    : { 动作: 'send_private_msg', 字段: 'user_id', 号: Number(数字) };
}

async function 发段(to, 段s) {
  const { 动作, 字段, 号 } = 解析目标(to);
  const 结果 = await 调接口(动作, { [字段]: 号, message: 段s });
  return 结果.message_id;
}

function 本地路径(文件) {
  const 原 = String(文件 ?? '').trim();
  if (!原) throw new Error('路径是空的');
  if (/^https?:\/\//i.test(原)) return 原;
  const 规整 = 原.replace(/^file:\/\/\/?/i, '');
  if (!existsSync(规整)) throw new Error(`文件不存在：${规整}`);
  return 规整.replace(/\\/g, '/');
}

const 音频时长 = (文件) => {
  try {
    const 头 = readFileSync(文件);
    let 位置 = 12;
    let 字节每秒 = 0;
    while (位置 + 8 < 头.length) {
      const 块 = 头.toString('ascii', 位置, 位置 + 4);
      const 长 = 头.readUInt32LE(位置 + 4);
      if (块 === 'fmt ' && 位置 + 24 < 头.length) {
        const 声道 = 头.readUInt16LE(位置 + 10);
        const 采样 = 头.readUInt32LE(位置 + 12);
        const 位深 = 头.readUInt16LE(位置 + 22);
        字节每秒 = 声道 * 采样 * (位深 / 8);
      }
      if (块 === 'data' && 字节每秒 > 0) return 长 / 字节每秒;
      位置 += 8 + 长 + (长 % 2);
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/** 把裸 PCM16 单声道包成 wav 文件 */
function pcm转wav(pcm, 采样率, 输出路径) {
  const 头 = Buffer.alloc(44);
  const 数据长 = pcm.length;
  头.write('RIFF', 0, 'ascii');
  头.writeUInt32LE(36 + 数据长, 4);
  头.write('WAVE', 8, 'ascii');
  头.write('fmt ', 12, 'ascii');
  头.writeUInt32LE(16, 16);
  头.writeUInt16LE(1, 20);
  头.writeUInt16LE(1, 22);
  头.writeUInt32LE(采样率, 24);
  头.writeUInt32LE(采样率 * 2, 28);
  头.writeUInt16LE(2, 32);
  头.writeUInt16LE(16, 34);
  头.write('data', 36, 'ascii');
  头.writeUInt32LE(数据长, 40);
  mkdirSync(dirname(输出路径), { recursive: true });
  writeFileSync(输出路径, Buffer.concat([头, pcm]));
  return 输出路径;
}

function 合成语音SAPI(文本, 输出, 速率 = 0) {
  const b64 = Buffer.from(文本, 'utf8').toString('base64');
  const 脚本 = [
    'Add-Type -AssemblyName System.Speech',
    `$b = [Convert]::FromBase64String('${b64}')`,
    '$t = [Text.Encoding]::UTF8.GetString($b)',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1",
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
    `$s.Rate = ${Math.max(-10, Math.min(10, Number(速率) || 0))}`,
    `$s.SetOutputToWaveFile('${输出.replace(/'/g, "''")}')`,
    '$s.Speak($t)',
    '$s.Dispose()',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    const 子 = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 脚本], {
      windowsHide: true,
    });
    let 错 = '';
    子.stderr.on('data', (块) => {
      错 += String(块);
    });
    子.on('error', reject);
    子.on('close', (码) => (码 === 0 ? resolve() : reject(new Error(`SAPI 退出码 ${码}：${错.slice(0, 300)}`))));
  });
}

async function 合成语音Edge(文本, 输出, 选项 = {}) {
  const c = { ...媒体配置(), ...(选项.覆盖 ?? {}) };
  // edge-tts 要求音调/语速带正负号，用户随手写 "18Hz" 也能用
  const 带符号 = (值, 默认) => {
    const 原 = String(值 ?? 默认 ?? '').trim();
    if (!原) return 默认;
    return /^[+-]/.test(原) ? 原 : `+${原}`;
  };
  const 参数 = [
    '-m',
    'edge_tts',
    '--voice',
    String(选项.voice || c.edgeVoice),
    '--pitch',
    带符号(选项.pitch, c.edgePitch),
    '--rate',
    带符号(选项.rate2, c.edgeRate),
    '--text',
    文本,
    '--write-media',
    输出,
  ];
  const 跑一次 = () =>
    new Promise((resolve, reject) => {
      const 子 = spawn(c.python, 参数, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      let 错 = '';
      子.stderr.on('data', (块) => {
        错 += String(块);
        if (错.length > 4000) 错 = 错.slice(-4000);
      });
      子.on('error', (错) => reject(new Error(`edge-tts 起不来：${错.message}`)));
      子.on('close', (码) => (码 === 0 && existsSync(输出) ? resolve() : reject(new Error(`edge-tts 退出码 ${码}：${错.slice(-400)}`))));
    });

  // 微软那边偶尔抽风（403 / 空音频），重试两三次基本都过；别一次失败就掉到 SAPI
  let 最后错;
  for (let 次 = 1; 次 <= 3; 次++) {
    try {
      await 跑一次();
      if (existsSync(输出) && readFileSync(输出).length >= 500) return 输出;
      最后错 = new Error('edge-tts 没生成有效音频');
    } catch (错) {
      最后错 = 错;
    }
    if (次 < 3) await new Promise((再) => setTimeout(再, 400 * 次));
  }
  throw 最后错 ?? new Error('edge-tts 失败');
}

async function 探活(apiUrl, 毫秒 = 2500) {
  try {
    const r = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(毫秒) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function 等就绪(apiUrl, 最长秒 = 300) {
  const 起 = Date.now();
  while ((Date.now() - 起) / 1000 < 最长秒) {
    const 健 = await 探活(apiUrl);
    if (健?.status === 'ok') return 健;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function 起Breeze(c) {
  const 运行 = await 探活(c.apiUrl);
  if (运行?.status === 'ok') return { 已启动: false, 健康: 运行 };
  if (!c.autoStart) throw new Error('Breeze TTS 服务没在跑（autoStart 关着）');
  if (!existsSync(c.python)) throw new Error(`找不到 Python：${c.python}`);
  const 端口 = Number(new URL(c.apiUrl).port || 80);
  const 日志 = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-media', 'breeze-server.log');
  mkdirSync(dirname(日志), { recursive: true });
  const 子 = spawn(c.python, ['-m', 'breeze_infer.api', c.modelDir, '--host', '127.0.0.1', '--port', String(端口)], {
    cwd: c.serverDir,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  子.unref();
  const 健康 = await 等就绪(c.apiUrl, 300);
  if (!健康) throw new Error('Breeze TTS 拉起失败（300 秒内没就绪），看 ~/.dsh/qq-media/breeze-server.log');
  return { 已启动: true, 健康 };
}

async function 合成语音Breeze(文本, 输出, 选项 = {}) {
  const c = { ...媒体配置(), ...(选项.覆盖 ?? {}) };
  await 起Breeze(c);
  const 表单 = new FormData();
  表单.set('text', 文本);
  表单.set('instruction', 选项.instruction || c.instruction);
  表单.set('cfg_scale', String(选项.cfgScale ?? c.cfgScale ?? 4));
  表单.set('seed', String(选项.seed ?? Math.floor(Math.random() * 100000)));
  const r = await fetch(`${c.apiUrl}/v1/audio/speech`, {
    method: 'POST',
    body: 表单,
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) {
    const 错 = await r.text().catch(() => '');
    throw new Error(`Breeze 合成失败 HTTP ${r.status}：${错.slice(0, 300)}`);
  }
  const 采样率 = Number(r.headers.get('x-sample-rate') || 24000);
  const pcm = Buffer.from(await r.arrayBuffer());
  if (pcm.length < 1000) throw new Error('Breeze 返回的音频太短');
  pcm转wav(pcm, 采样率, 输出);
  return 输出;
}

const 工具输出 = (字段, 渲染) => ({
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean', description: '这次操作成没成' }, ...字段 },
    required: ['ok'],
  },
  render: (_args, value) => [{ type: 'text', text: 渲染(value ?? {}) }],
});

export function apply(ctx, 配置) {
  const c = { ...(配置 ?? {}) };
  if (c.enabled === false) return;

  ctx.tools.register({
    name: 'qq_send_voice',
    description:
      '把一段话合成语音条发给某人（群写 "group:群号"）。默认用微软在线「晓伊」少女音，1~2 秒就好；想要别的音色可指定 voice（zh-CN-XiaoyiNeural 少女、zh-CN-XiaoxiaoNeural 温柔、zh-CN-shaanxi-XiaoniNeural 亮）。文本写成口语，别带 Markdown 和表情符号。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '接收人 QQ 号；发群写 "group:群号"' },
        text: { type: 'string', description: '要念出来的话，纯口语，一两句最自然' },
        voice: {
          type: 'string',
          description: '音色 id，默认 zh-CN-XiaoyiNeural（晓伊，少女）；也可 zh-CN-XiaoxiaoNeural、zh-CN-shaanxi-XiaoniNeural',
        },
        pitch: { type: 'string', description: '音调，如 "+18Hz"；调高更幼更甜' },
        rate: { type: 'string', description: '语速，如 "+3%" 或 "-5%"' },
        engine: { type: 'string', enum: ['edge', 'breeze', 'sapi'], description: '默认 edge；breeze 本机模型更自然但慢' },
      },
      required: ['to', 'text'],
    },
    output: 工具输出(
      { message_id: { type: 'string' }, seconds: { type: 'number' }, engine: { type: 'string' }, file: { type: 'string' } },
      (v) =>
        v.ok
          ? `已发语音给 ${v.to ?? ''}（${v.engine}，${v.seconds ? v.seconds.toFixed(1) + ' 秒' : '时长未知'}）`
          : `发语音失败：${v.错误 ?? '未知原因'}`,
    ),
    async execute(args) {
      const 文本 = 清洗文本(args.text);
      if (!文本) return { ok: false, 错误: '没有要念的内容' };
      const 配置 = 媒体配置();
      const 想要 = args.engine || 配置.engine || 'edge';
      // SAPI 难听，只有明确点名或配置里允许时才当兜底，不然宁可报错让它重说一遍
      const 兜底 = 配置.allowSapiFallback === true ? ['sapi'] : [];
      const 顺序 =
        想要 === 'sapi'
          ? ['sapi']
          : 想要 === 'breeze'
            ? ['breeze', 'edge', ...兜底]
            : ['edge', ...兜底];
      const 错过 = [];
      for (const 引擎 of 顺序) {
        const 后缀 = 引擎 === 'edge' ? '.mp3' : '.wav';
        const 文件 = join(tmpdir(), `dsh-qq-voice-${randomUUID().slice(0, 8)}${后缀}`);
        try {
          if (引擎 === 'edge') {
            await 合成语音Edge(文本, 文件, { voice: args.voice, pitch: args.pitch, rate2: args.rate });
          } else if (引擎 === 'breeze') {
            await 合成语音Breeze(文本, 文件, { instruction: args.instruction });
          } else {
            await 合成语音SAPI(文本, 文件, Number(args.rate) || 0);
          }
          const id = await 发段(args.to, [{ type: 'record', data: { file: 本地路径(文件) } }]);
          return {
            ok: true,
            to: args.to,
            message_id: String(id ?? ''),
            seconds: 引擎 === 'edge' ? undefined : 音频时长(文件),
            engine: 引擎,
            file: 文件,
            ...(错过.length ? { 备注: 错过.join('; ') } : {}),
          };
        } catch (错) {
          错过.push(`${引擎}: ${String(错?.message ?? 错)}`);
        }
      }
      return { ok: false, 错误: 错过.join('; ') };
    },
  });

  ctx.tools.register({
    name: 'qq_send_video',
    description: '把本机上的一个视频文件当 QQ 视频消息发给某人。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '接收人 QQ 号；发群写 "group:群号"' },
        path: { type: 'string', description: '视频绝对路径（mp4 最稳）' },
      },
      required: ['to', 'path'],
    },
    output: 工具输出({ message_id: { type: 'string' }, file: { type: 'string' } }, (v) =>
      v.ok ? `视频已发出：${v.file ?? ''}` : `发视频失败：${v.错误 ?? '未知原因'}`,
    ),
    async execute(args) {
      try {
        const 文件 = 本地路径(args.path);
        const id = await 发段(args.to, [{ type: 'video', data: { file: 文件 } }]);
        return { ok: true, message_id: String(id ?? ''), file: 文件 };
      } catch (错) {
        return { ok: false, 错误: String(错?.message ?? 错) };
      }
    },
  });

  ctx.tools.register({
    name: 'qq_send_file',
    description: '把本机上的任意文件当 QQ 文件发给某人。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '接收人 QQ 号；发群写 "group:群号"' },
        path: { type: 'string', description: '文件绝对路径' },
        name: { type: 'string', description: '显示的文件名（可选）' },
      },
      required: ['to', 'path'],
    },
    output: 工具输出({ message_id: { type: 'string' }, file: { type: 'string' } }, (v) =>
      v.ok ? `文件已发出：${v.file ?? ''}` : `发文件失败：${v.错误 ?? '未知原因'}`,
    ),
    async execute(args) {
      try {
        const 文件 = 本地路径(args.path);
        const 数据 = { file: 文件 };
        if (args.name) 数据.name = String(args.name);
        const id = await 发段(args.to, [{ type: 'file', data: 数据 }]);
        return { ok: true, message_id: String(id ?? ''), file: 文件 };
      } catch (错) {
        return { ok: false, 错误: String(错?.message ?? 错) };
      }
    },
  });

  ctx.tools.register({
    name: 'qq_send_image',
    description: '发一张图片（本机路径或网络 URL 都行），走 QQ 图片消息而不是文字链接。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '接收人 QQ 号；发群写 "group:群号"' },
        source: { type: 'string', description: '图片绝对路径或 http(s) 链接' },
      },
      required: ['to', 'source'],
    },
    output: 工具输出({ message_id: { type: 'string' } }, (v) => (v.ok ? '图片已发出' : `发图失败：${v.错误 ?? '未知原因'}`)),
    async execute(args) {
      try {
        const 源 = String(args.source ?? '').trim();
        const 文件 = /^https?:\/\//i.test(源) ? 源 : 本地路径(源);
        const id = await 发段(args.to, [{ type: 'image', data: { file: 文件 } }]);
        return { ok: true, message_id: String(id ?? '') };
      } catch (错) {
        return { ok: false, 错误: String(错?.message ?? 错) };
      }
    },
  });

  ctx.tools.register({
    name: 'qq_media_check',
    description: '自检：OneBot 通不通、登录哪个号、edge-tts 能不能用、Breeze TTS 服务在不在、SAPI 兜底可用不可用。',
    parameters: { type: 'object', properties: {} },
    output: 工具输出(
      { login: { type: 'string' }, baseUrl: { type: 'string' }, edge: { type: 'string' }, breeze: { type: 'string' }, sapi: { type: 'boolean' }, 版本: { type: 'string' } },
      (v) =>
        v.ok
          ? `v${v.版本 ?? '?'}：OneBot 通：${v.baseUrl}，登录 ${v.login}；edge-tts：${v.edge}；Breeze：${v.breeze}；SAPI 兜底 ${v.sapi ? '可用' : '不可用'}`
          : `自检失败：${v.错误 ?? ''}`,
    ),
    async execute() {
      const { baseUrl } = 连接配置();
      const c = 媒体配置();
      let 登录 = '';
      try {
        const 信息 = await 调接口('get_login_info', {});
        登录 = `${信息.nickname ?? ''}(${信息.user_id ?? ''})`;
      } catch (错) {
        return { ok: false, baseUrl, edge: '-', breeze: '-', sapi: false, 错误: String(错?.message ?? 错) };
      }
      let edge = '不可用';
      try {
        const 文件 = join(tmpdir(), `dsh-qq-edge-${randomUUID().slice(0, 6)}.mp3`);
        await 合成语音Edge('测试', 文件, {});
        edge = `可用（${c.edgeVoice}）`;
      } catch (错) {
        edge = `不可用：${String(错?.message ?? 错).slice(0, 160)}`;
      }
      let breeze = '没在跑';
      try {
        const 健 = await 探活(c.apiUrl, 8000);
        breeze = 健?.status === 'ok' ? `在线（${c.apiUrl}，${健.sample_rate}Hz）` : '没在跑';
      } catch {
        breeze = '没在跑';
      }
      let sapi = false;
      try {
        const 文件 = join(tmpdir(), `dsh-qq-tts-${randomUUID().slice(0, 6)}.wav`);
        await 合成语音SAPI('测试', 文件);
        sapi = existsSync(文件);
      } catch {
        sapi = false;
      }
      return { ok: true, baseUrl, login: 登录, edge, breeze, sapi, 版本 };
    },
  });

  // 版本探针：外面 curl 一下就知道宿主里跑的是哪个版本的这份代码
  if (typeof ctx.inject === 'function')
    ctx.inject(['webServer'], (子) => {
    子.effect(() =>
      子.webServer.register({
        kind: 'prefix',
        path: '/api/qq-media',
        handler: async (req, res) => {
          const 路径 = new URL(req.url, 'http://127.0.0.1').pathname;
          const c = 媒体配置();
          if (路径 === '/api/qq-media/ping') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, version: 版本, engine: c.engine, edgeVoice: c.edgeVoice, pid: process.pid }));
            return;
          }
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{}');
        },
      }),
    );
  });
}
