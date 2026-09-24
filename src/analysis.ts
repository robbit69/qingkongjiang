import { linesAsText, segmentFromIds, type ApiCall, type Segment, type Settings, type Window } from './core';

export type AnalysisResult = { segments: Segment[]; warning?: string; calls?: ApiCall[] };
export type Choice = { id: string; probability: number; margin: number };
export type StageDecision = {
  probability: number;
  firstLineProbability: number;
  lastLineProbability: number;
  multipleProbability: number;
  start: Choice;
  end: Choice;
};
export type StageResult = { decision?: StageDecision; segments: Segment[]; warning?: string; calls: ApiCall[] };
type JevAnswer = { noul?: number; choice?: string; probabilities?: Record<string, number>; confidence?: number };
type Usage = { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number; cost?: number; total_cost?: number };
type JevResponse = { answers?: Record<string, JevAnswer>; usage?: Usage };

export function jevEndpoint(host: string): string {
  const url = new URL(host.trim() || 'https://api.typesafe.ai');
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Jev Host 须使用 HTTPS，或本机 HTTP；不要包含账号、参数或锚点');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = `${path.replace(/\/v1\/systemone$|\/v1$/, '')}/v1/systemone`;
  return url.href;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, onAttempt?: () => void): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    onAttempt?.();
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status === 529) && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 700 * 2 ** attempt));
      continue;
    }
    const detail = (await response.text()).slice(0, 160);
    throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`);
  }
  throw new Error('接口重试失败');
}

async function trackedPostJson(url: string, headers: Record<string, string>, body: unknown, provider: ApiCall['provider'], model: string, settings: Settings, calls: ApiCall[]): Promise<unknown> {
  const start = performance.now();
  let attempts = 0;
  let data: unknown;
  let failed = true;
  try {
    data = await postJson(url, headers, body, () => { attempts++; });
    failed = false;
    return data;
  } finally {
    const payload = data && typeof data === 'object' ? data as { usage?: Usage } : {};
    const usage = payload.usage;
    const input = usage?.input_tokens ?? usage?.prompt_tokens;
    const output = usage?.output_tokens ?? usage?.completion_tokens;
    const inputTokens = Number.isSafeInteger(input) && Number(input) >= 0 ? Number(input) : null;
    const outputTokens = Number.isSafeInteger(output) && Number(output) >= 0 ? Number(output) : null;
    const reportedCost = usage?.cost ?? usage?.total_cost;
    const directCost = typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : null;
    const configuredCost = provider === 'jev'
      ? inputTokens === null ? null : inputTokens * 0.042 / 1_000_000
      : inputTokens === null || outputTokens === null || !(settings.llmInputUsdPerMillion > 0 || settings.llmOutputUsdPerMillion > 0)
        ? null : (inputTokens * settings.llmInputUsdPerMillion + outputTokens * settings.llmOutputUsdPerMillion) / 1_000_000;
    calls.push({ provider, model, elapsedMs: performance.now() - start, attempts, inputTokens, outputTokens, costUsd: directCost ?? configuredCost, failed });
  }
}

function questionCriteria(window: Window): Record<string, null> {
  return Object.fromEntries(window.lines.map(line => [line.id, null]));
}

function probability(answer: JevAnswer | undefined, name: string): number {
  if (typeof answer?.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error(`Jev 返回的 ${name} 概率无效`);
  }
  return answer.noul;
}

function choice(answer: JevAnswer | undefined, validIds: Set<string>, name: string): Choice {
  if (!answer?.choice || !validIds.has(answer.choice)) throw new Error(`Jev 返回的 ${name} 编号无效`);
  const score = answer.probabilities?.[answer.choice] ?? answer.confidence;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new Error(`Jev 返回的 ${name} 概率无效`);
  const alternative = Math.max(0, ...Object.entries(answer.probabilities ?? {})
    .filter(([id]) => id !== answer.choice).map(([, value]) => Number.isFinite(value) ? value : 0));
  return { id: answer.choice, probability: score, margin: score - alternative };
}

export async function analyzeWithJev(window: Window, settings: Settings, calls: ApiCall[] = []): Promise<StageDecision | null> {
  if (!settings.jevKey) throw new Error('请先在扩展设置中填写 Jev API Key');
  if (window.lines.length < 1 || window.lines.length > 254) throw new Error('单阶段字幕最多 254 条');
  const state = linesAsText(window.lines);
  const headers = { 'Authorization': `Bearer ${settings.jevKey}`, 'Content-Type': 'application/json' };
  const endpoint = jevEndpoint(settings.jevHost);
  const first = window.lines[0].id;
  const last = window.lines.at(-1)!.id;
  const ids = questionCriteria(window);
  const response = await trackedPostJson(endpoint, headers, {
    model: settings.jevModel || 'jev-latest',
    state,
    questions: {
      has_promotion: {
        type: 'noul',
        instructions: '本阶段字幕是否包含明确的口播商业推广或赞助？普通剧情和非商业品牌提及不算。同一商家的价格、品质、售后、活动福利连续介绍算同一段推广。',
      },
      first_line_is_promotion: { type: 'noul', instructions: `本阶段第一句 ${first} 本身是否属于正在进行的口播商业推广？只看这句是否是推广的一部分，不要求推广从这句开始。` },
      last_line_is_promotion: { type: 'noul', instructions: `本阶段最后一句 ${last} 本身是否属于正在进行的口播商业推广？只看这句是否是推广的一部分，不要求推广在这句结束。` },
      multiple_promotions: { type: 'noul', instructions: '本阶段是否包含两段或以上彼此独立、之间已恢复正常非商业内容的商业口播推广？同一商家的价格、品质、售后及活动福利连续介绍只算一段。' },
      start: { type: 'choice', instructions: `选择本阶段第一段明确商业推广在本阶段内的第一句编号。如果本阶段无广告，或这段广告在 ${first} 之前就已开始，选择 NO_START。`, criteria: { NO_START: '本阶段没有广告，或第一段广告在本阶段开始前已经开始', ...ids } },
      end: { type: 'choice', instructions: `选择本阶段第一段明确商业推广在本阶段内的最后一句编号。同一商家的价格、品质、售后、活动福利连续介绍属于同一段；以恢复正常非商业内容前的最后一句为准。如果本阶段无广告，或推广在 ${last} 之后仍继续，选择 NO_END。`, criteria: { NO_END: '本阶段没有广告，或第一段广告在本阶段结束后仍在继续', ...ids } },
    },
  }, 'jev', settings.jevModel || 'jev-latest', settings, calls) as JevResponse;
  const has = probability(response.answers?.has_promotion, '广告存在');
  const threshold = Math.max(0.5, Math.min(0.99, settings.jevThreshold));
  // Negative stages still contain forced choice answers; never turn those into an interval.
  if (has <= 0.3) return null;
  if (has < threshold) throw new Error(`Jev 判定不确定（${Math.round(has * 100)}%）`);
  const validStart = new Set(['NO_START', ...window.lines.map(line => line.id)]);
  const validEnd = new Set(['NO_END', ...window.lines.map(line => line.id)]);
  return {
    probability: has,
    firstLineProbability: probability(response.answers?.first_line_is_promotion, '阶段首句'),
    lastLineProbability: probability(response.answers?.last_line_is_promotion, '阶段末句'),
    multipleProbability: probability(response.answers?.multiple_promotions, '多段口播'),
    start: choice(response.answers?.start, validStart, '起点'),
    end: choice(response.answers?.end, validEnd, '终点'),
  };
}

export async function refineBoundaries(window: Window, settings: Settings): Promise<AnalysisResult> {
  const calls: ApiCall[] = [];
  try {
    if (!settings.jevKey) throw new Error('请先填写 Jev API Key');
    if (window.lines.length < 2 || window.lines.length > 254) throw new Error('边界字幕窗口无效');
    const response = await trackedPostJson(jevEndpoint(settings.jevHost), {
      'Authorization': `Bearer ${settings.jevKey}`, 'Content-Type': 'application/json',
    }, {
      model: settings.jevModel || 'jev-latest', state: linesAsText(window.lines), questions: {
        start: { type: 'choice', instructions: '选择这段字幕中明确商业口播推广的第一句编号。剧情铺垫不算；从开始介绍商品或商家并面向观众推荐的第一句算起。', criteria: questionCriteria(window) },
        end: { type: 'choice', instructions: '选择这段字幕中同一段商业口播推广的最后一句编号。同一商家的价格、品质、售后、活动福利连续介绍都算这一段，短暂停顿不算结束；恢复普通剧情之前的最后一句才是终点。', criteria: questionCriteria(window) },
      },
    }, 'jev', settings.jevModel || 'jev-latest', settings, calls) as JevResponse;
    const ids = new Set(window.lines.map(line => line.id));
    const start = choice(response.answers?.start, ids, '起点');
    const end = choice(response.answers?.end, ids, '终点');
    const segment = segmentFromIds(window.lines, start.id, end.id, 'jev');
    if (!segment) throw new Error('Jev 补问的起止顺序无效');
    segment.boundaryConfidence = Math.min(start.probability, end.probability);
    return { segments: [segment], calls };
  } catch (error) {
    return { segments: [], warning: error instanceof Error ? error.message : String(error), calls };
  }
}

function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

export async function analyzeWithLlm(window: Window, settings: Settings, calls: ApiCall[] = []): Promise<AnalysisResult> {
  if (!settings.llmEnabled || !settings.llmModel || !settings.llmUrl) throw new Error('LLM 兜底尚未配置');
  const endpoint = new URL(settings.llmUrl);
  if (!['https:', 'http:'].includes(endpoint.protocol) || (endpoint.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname))) {
    throw new Error('LLM 接口须使用 HTTPS，或本机 HTTP');
  }
  const response = await trackedPostJson(endpoint.href, {
    'Content-Type': 'application/json',
    ...(settings.llmKey ? { 'Authorization': `Bearer ${settings.llmKey}` } : {}),
  }, {
    model: settings.llmModel,
    temperature: 0,
    messages: [
      { role: 'system', content: '你只分析视频 CC 字幕中的明确口播商业推广或赞助。普通内容介绍不是推广。回复纯 JSON：{"segments":[{"start":"L00001","end":"L00009"}]}，没有则返回 {"segments":[]}。编号必须来自输入，start/end 为推广的首尾句。' },
      { role: 'user', content: linesAsText(window.lines) },
    ],
  }, 'llm', settings.llmModel, settings, calls) as { choices?: { message?: { content?: string } }[] };
  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM 没有返回内容');
  const parsed = extractJson(text) as { segments?: { start?: unknown; end?: unknown }[] };
  if (!Array.isArray(parsed.segments)) throw new Error('LLM 返回格式无效');
  const segments: Segment[] = [];
  for (const item of parsed.segments.slice(0, 5)) {
    if (typeof item.start !== 'string' || typeof item.end !== 'string') throw new Error('LLM 返回的字幕编号无效');
    const segment = segmentFromIds(window.lines, item.start, item.end, 'llm');
    if (!segment) throw new Error('LLM 返回的起止顺序或字幕编号无效');
    segments.push(segment);
  }
  return { segments };
}

export async function analyzeStage(window: Window, settings: Settings): Promise<StageResult> {
  const calls: ApiCall[] = [];
  try {
    const decision = await analyzeWithJev(window, settings, calls);
    return { decision: decision ?? undefined, segments: [], calls };
  } catch (error) {
    const jevError = error instanceof Error ? error.message : String(error);
    if (!settings.llmEnabled) return { segments: [], warning: jevError, calls };
    try {
      const fallback = await analyzeWithLlm(window, settings, calls);
      return { ...fallback, warning: `Jev：${jevError}；已用 LLM 兜底`, calls };
    } catch (fallbackError) {
      return { segments: [], warning: `Jev：${jevError}；LLM：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`, calls };
    }
  }
}

export async function testConnections(settings: Settings): Promise<{ jev: { ok: boolean; message: string; elapsedMs: number }; llm?: { ok: boolean; message: string; elapsedMs: number } }> {
  const testJev = async () => {
    const start = performance.now();
    try {
      if (!settings.jevKey) throw new Error('未填写 Jev API Key');
      const response = await postJson(jevEndpoint(settings.jevHost), {
        'Authorization': `Bearer ${settings.jevKey}`, 'Content-Type': 'application/json',
      }, {
        model: settings.jevModel || 'jev-latest',
        state: '这是一段普通的视频开场白。',
        questions: { connected: { type: 'noul', instructions: '这段话是否包含文字？' } },
      }) as JevResponse;
      if (typeof response.answers?.connected?.noul !== 'number') throw new Error('响应格式无效');
      return { ok: true, message: '连接成功', elapsedMs: performance.now() - start };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), elapsedMs: performance.now() - start };
    }
  };
  const testLlm = async () => {
    const start = performance.now();
    try {
      if (!settings.llmUrl || !settings.llmModel) throw new Error('未填写 LLM 接口和模型');
      const endpoint = new URL(settings.llmUrl);
      if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) throw new Error('LLM 接口地址无效');
      const response = await postJson(endpoint.href, {
        'Content-Type': 'application/json',
        ...(settings.llmKey ? { 'Authorization': `Bearer ${settings.llmKey}` } : {}),
      }, {
        model: settings.llmModel,
        messages: [{ role: 'user', content: '请回复 OK' }],
        max_tokens: 8,
      }) as { choices?: { message?: { content?: string } }[] };
      if (!response.choices?.[0]?.message?.content) throw new Error('响应格式无效');
      return { ok: true, message: '连接成功', elapsedMs: performance.now() - start };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), elapsedMs: performance.now() - start };
    }
  };
  const jev = await testJev();
  return settings.llmEnabled ? { jev, llm: await testLlm() } : { jev };
}
