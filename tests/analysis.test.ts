import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeStage, jevEndpoint, refineBoundaries } from '../src/analysis';
import { DEFAULT_SETTINGS, makeWindows, summarizeCalls } from '../src/core';

const window = makeWindows([
  { from: 0, to: 2, content: '普通内容' },
  { from: 2, to: 4, content: '感谢品牌赞助' },
  { from: 4, to: 6, content: '现在介绍产品' },
  { from: 6, to: 8, content: '继续正片' },
])[0];
const settings = { ...DEFAULT_SETTINGS, jevKey: 'test-key', jevThreshold: 0.8 };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function stageAnswers(has: number) {
  return { has_promotion: { noul: has }, first_line_is_promotion: { noul: 0.04 },
    last_line_is_promotion: { noul: 0.05 }, multiple_promotions: { noul: 0.01 },
    start: { choice: 'L00001', probabilities: { L00001: 0.9, L00000: 0.05 } },
    end: { choice: 'L00002', probabilities: { L00002: 0.8, L00003: 0.1 } } };
}

afterEach(() => vi.unstubAllGlobals());

describe('阶段式 Jev 与 LLM 兜底', () => {
  it('一次请求同时判断口播与两个边界，并记录用量', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ answers: stageAnswers(0.94), usage: { input_tokens: 1000, output_tokens: 8 } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await analyzeStage(window, settings);
    expect(result.decision).toMatchObject({ probability: 0.94, start: { id: 'L00001' }, end: { id: 'L00002' } });
    expect(summarizeCalls(result.calls)).toMatchObject({ inputTokens: 1000, outputTokens: 8, costUsd: 0.000042, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(body.questions)).toEqual(['has_promotion', 'first_line_is_promotion', 'last_line_is_promotion', 'multiple_promotions', 'start', 'end']);
    expect(Object.keys(body.questions.start.criteria)).toHaveLength(5);
  });

  it('无广告时忽略 Jev 强制给出的起止选项', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ answers: stageAnswers(0.22) })));
    const result = await analyzeStage(window, settings);
    expect(result.decision).toBeUndefined();
    expect(result.segments).toEqual([]);
  });

  it('边界补问只提交起点与终点两个问题', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ answers: {
      start: { choice: 'L00001', probabilities: { L00001: 0.78 } },
      end: { choice: 'L00002', probabilities: { L00002: 0.68 } },
    } }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await refineBoundaries(window, settings)).segments).toEqual([
      { start: 2, end: 6, source: 'jev', confidence: undefined, boundaryConfidence: 0.68 },
    ]);
    expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body as string).questions)).toEqual(['start', 'end']);
  });

  it('自定义 Jev Host 拼接接口路径，并拒绝非本机 HTTP', () => {
    expect(jevEndpoint('https://jev.example.com/api')).toBe('https://jev.example.com/api/v1/systemone');
    expect(jevEndpoint('https://api.typesafe.ai/v1')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(() => jevEndpoint('http://jev.example.com')).toThrow();
  });

  it('Jev 不确定时使用 LLM，并使结果保持待核对', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ answers: stageAnswers(0.55) }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: '{"segments":[{"start":"L00001","end":"L00002"}]}' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await analyzeStage(window, { ...settings, llmEnabled: true, llmUrl: 'https://example.com/v1/chat/completions', llmModel: 'test' });
    expect(result.segments).toEqual([{ start: 2, end: 6, source: 'llm', confidence: undefined }]);
    expect(result.warning).toContain('已用 LLM 兜底');
  });
});
