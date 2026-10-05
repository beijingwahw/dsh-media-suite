import type { Modality } from './protocol.js';

/**
 * 单价表 → CNY 折算。
 *
 * ★ 真实数据接地（2026-10-05 核实，全部来自官方定价页）：
 *  - wanx2.1-t2i-turbo  图片生成 0.14 元/张
 *    来源：https://help.aliyun.com/zh/model-studio/wanx2-1-t2i-turbo （2026-09-11）
 *  - wanx2.1-imageedit  图像编辑 0.14 元/张
 *    来源：https://developer.aliyun.com/article/1763163 百炼收费标准汇总（2026-09-14）
 *  - wanx2.1-t2v-turbo  视频生成 480P/720P 0.24 元/秒
 *    来源：同上（2026-09-14）
 *  - qwen3-tts-flash    语音合成 0.8 元/万字符 = 0.00008 元/字符（0.08 元/千字符）
 *    来源：https://help.aliyun.com/zh/model-studio/qwen3-tts-flash （2026-09-11）
 *  - gpt-image-1        低质量档 $0.011/张 ≈ 0.08 元/张（按 7.2 汇率）
 *    来源：OpenAI API 定价页（2026-10 核对）
 *  - gpt-4o-mini-tts    $0.6/百万字符 ≈ 0.0043 元/千字符（按 7.2 汇率）
 *    来源：OpenAI API 定价页（2026-10 核对）
 *
 * ⚠️ 计费口径注意：百炼 TTS 字符数按「1 汉字=2 字符」计（ISI 计费说明），
 * 本表按请求文本长度/1000 估算 kchar，中文场景实际成本约为估算值 2 倍，
 * 预算请预留余量；精确结算走 provider usage 回传（quantity 优先）。
 * 官方调价后请更新此表。
 */

export interface PriceRule {
  /** 计价单位 */
  unit: 'image' | 'second' | 'kchar';
  cnyPerUnit: number;
  /** 数据来源与核实日期 */
  source?: string;
}

export const DEFAULT_PRICES: Record<string, Partial<Record<Modality, PriceRule>>> = {
  bailian: {
    image: { unit: 'image', cnyPerUnit: 0.14, source: 'help.aliyun.com wanx2.1-t2i-turbo, 2026-10-05 核实' },
    'image-edit': { unit: 'image', cnyPerUnit: 0.14, source: 'wanx2.1-imageedit 0.14元/张, 2026-10-05 核实' },
    video: { unit: 'second', cnyPerUnit: 0.24, source: 'wanx2.1-t2v-turbo 480P/720P 0.24元/秒, 2026-10-05 核实' },
    speech: { unit: 'kchar', cnyPerUnit: 0.08, source: 'qwen3-tts-flash 0.8元/万字符, 2026-10-05 核实' }
  },
  openai: {
    image: { unit: 'image', cnyPerUnit: 0.08, source: 'gpt-image-1 low $0.011/张 @7.2, 2026-10-05 核实' },
    speech: { unit: 'kchar', cnyPerUnit: 0.0043, source: 'gpt-4o-mini-tts $0.6/M字符 @7.2, 2026-10-05 核实' }
  },
  comfyui: {
    // 本地推理：仅电费，记 0
    image: { unit: 'image', cnyPerUnit: 0 },
    video: { unit: 'second', cnyPerUnit: 0 },
    speech: { unit: 'kchar', cnyPerUnit: 0 }
  }
};

export interface EstimateInput {
  provider: string;
  modality: Modality;
  /** 图片张数 / 视频秒数 / 文本千字符数 */
  quantity: number;
}

export class Pricing {
  private table: Record<string, Partial<Record<Modality, PriceRule>>>;

  constructor(table: Record<string, Partial<Record<Modality, PriceRule>>> = DEFAULT_PRICES) {
    this.table = table;
  }

  /** 估算成本（CNY）；无单价规则时返回 0（不阻断，只影响预算精度） */
  estimate(input: EstimateInput): number {
    const rule = this.table[input.provider]?.[input.modality];
    if (!rule) return 0;
    return round4(rule.cnyPerUnit * Math.max(0, input.quantity));
  }
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 从请求参数推断计价数量 */
export function quantityOf(modality: Modality, params: Record<string, unknown>, textLength = 0): number {
  switch (modality) {
    case 'image':
    case 'image-edit':
      return Number(params.n ?? 1);
    case 'video':
      return Number(params.duration ?? 5);
    case 'speech':
      return textLength / 1000;
  }
}
