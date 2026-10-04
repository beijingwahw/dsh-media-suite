import type { Modality } from './protocol.js';

/**
 * 单价表 → CNY 折算。
 * 单价随官方调价变化，集中在此维护；金额均为「每单位」价格（人民币元）。
 * 来源标注在注释中，发布前需复核。
 */

export interface PriceRule {
  /** 计价单位 */
  unit: 'image' | 'second' | 'kchar';
  cnyPerUnit: number;
}

/** 默认单价表（CNY）。⚠️ 以各家官网最新定价为准，此处为 2026-10 快照。 */
export const DEFAULT_PRICES: Record<string, Partial<Record<Modality, PriceRule>>> = {
  bailian: {
    // 通义万相文生图 turbo 档，约 0.14 元/张（阿里云百炼官网定价页）
    image: { unit: 'image', cnyPerUnit: 0.14 },
    // 万相图生视频按秒计价，约 0.7 元/秒（档位差异大，取中间档）
    video: { unit: 'second', cnyPerUnit: 0.7 },
    // CosyVoice TTS 约 2 元/万字符 = 0.0002 元/千字符
    speech: { unit: 'kchar', cnyPerUnit: 0.0002 }
  },
  openai: {
    // gpt-image-1 低质量档 $0.011/张，按 7.2 汇率折 CNY
    image: { unit: 'image', cnyPerUnit: 0.08 },
    // gpt-4o-mini-tts $0.6/1M 字符 ≈ 0.0043 元/千字符
    speech: { unit: 'kchar', cnyPerUnit: 0.0043 }
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
