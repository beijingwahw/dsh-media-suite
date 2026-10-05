#!/usr/bin/env node
/**
 * 真实连通性冒烟测试 —— 用真实 API 验证各 Provider 链路。
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/smoke.mjs bailian-image
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/smoke.mjs bailian-tts
 *   OPENAI_API_KEY=sk-xxx    node scripts/smoke.mjs openai-image
 *   COMFYUI_ENDPOINT=http://127.0.0.1:8188 node scripts/smoke.mjs comfyui-health
 *   node scripts/smoke.mjs all     # 跑所有已配置 Key 的项
 *
 * 直接调各家真实 HTTP 端点（与 Provider 实现相同的路径与参数结构），
 * 不经过 core 队列，用于快速定位「是链路问题还是插件问题」。
 * 产物下载到 ./smoke-output/。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'smoke-output');
mkdirSync(OUT, { recursive: true });

const BAILIAN = 'https://dashscope.aliyuncs.com';
const OPENAI = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');

function key(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ 缺少环境变量 ${name}`);
    process.exit(2);
  }
  return v;
}

async function dashscopeAsyncTask(endpoint, body, label) {
  const res = await fetch(BAILIAN + endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key('DASHSCOPE_API_KEY')}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${data.message ?? JSON.stringify(data)}`);
  const taskId = data.output?.task_id;
  console.log(`  task_id=${taskId}`);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const q = await fetch(`${BAILIAN}/api/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` } });
    const qd = await q.json();
    const st = qd.output?.task_status;
    process.stdout.write(`  ${i}: ${st}\r`);
    if (st === 'SUCCEEDED') {
      console.log(`\n✓ ${label} 成功，usage=${JSON.stringify(qd.usage ?? {})}`);
      return qd.output;
    }
    if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') {
      throw new Error(`${label} ${st}: ${qd.output?.message ?? ''}`);
    }
  }
  throw new Error(`${label} 轮询超时`);
}

const cases = {
  'bailian-image': async () => {
    console.log('→ 百炼文生图（wanx2.1-t2i-turbo，真实计费约 0.14 元/张）');
    const out = await dashscopeAsyncTask(
      '/api/v1/services/aigc/text2image/image-synthesis',
      { model: 'wanx2.1-t2i-turbo', input: { prompt: '一只戴着宇航员头盔的黑色鲸鱼，数字艺术' }, parameters: { size: '1024*1024', n: 1 } },
      '文生图'
    );
    const url = out.results?.[0]?.url;
    if (!url) throw new Error('未返回图片 URL');
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const f = join(OUT, 'bailian-image.png');
    writeFileSync(f, buf);
    console.log(`✓ 已保存 ${f}（${buf.length} bytes）`);
  },

  'bailian-tts': async () => {
    console.log('→ 百炼语音合成（qwen3-tts-flash，REST 同步）');
    const res = await fetch(`${BAILIAN}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key('DASHSCOPE_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text: '你好，这是 dsh-media-suite 的真实链路冒烟测试。', voice: 'Cherry' } })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${data.message ?? JSON.stringify(data)}`);
    const url = data.output?.audio?.url;
    if (!url) throw new Error(`未返回音频 URL：${JSON.stringify(data).slice(0, 300)}`);
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const f = join(OUT, 'bailian-tts.mp3');
    writeFileSync(f, buf);
    console.log(`✓ 已保存 ${f}（${buf.length} bytes），usage=${JSON.stringify(data.usage ?? {})}`);
  },

  'openai-image': async () => {
    console.log('→ OpenAI 图像生成（gpt-image-1，真实计费约 $0.011+/张）');
    const res = await fetch(`${OPENAI}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a black whale astronaut, digital art', size: '1024x1024', n: 1 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
    const item = data.data?.[0];
    const buf = item.b64_json ? Buffer.from(item.b64_json, 'base64') : Buffer.from(await (await fetch(item.url)).arrayBuffer());
    const f = join(OUT, 'openai-image.png');
    writeFileSync(f, buf);
    console.log(`✓ 已保存 ${f}（${buf.length} bytes），usage=${JSON.stringify(data.usage ?? {})}`);
  },

  'comfyui-health': async () => {
    const ep = process.env.COMFYUI_ENDPOINT ?? 'http://127.0.0.1:8188';
    console.log(`→ ComfyUI 健康检查（${ep}）`);
    const res = await fetch(`${ep}/system_stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    console.log(`✓ ComfyUI 可达，版本 ${s?.system?.comfyui_version ?? '未知'}`);
  }
};

const target = process.argv[2] ?? 'all';
const list = target === 'all' ? Object.keys(cases).filter((c) => {
  if (c.startsWith('bailian')) return !!process.env.DASHSCOPE_API_KEY;
  if (c.startsWith('openai')) return !!process.env.OPENAI_API_KEY;
  return true;
}) : [target];

let failed = 0;
for (const c of list) {
  if (!cases[c]) { console.error(`未知用例：${c}（可选：${Object.keys(cases).join(', ')}, all）`); process.exit(2); }
  try {
    await cases[c]();
  } catch (e) {
    failed++;
    console.error(`✗ ${c} 失败：${e.message}`);
  }
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
