import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('用法：node scripts/make-jev-staged-test.mjs <字幕文本文件>');
  process.exit(1);
}
const outputDir = resolve('experiments');
const source = await readFile(inputPath, 'utf8');
const pattern = /^\[(\d+):(\d+):(\d+(?:\.\d+)?)–(\d+):(\d+):(\d+(?:\.\d+)?)\]\s*(.+)$/;
const cues = source.split(/\r?\n/).filter(Boolean).map((line, index) => {
  const match = line.match(pattern);
  if (!match) throw new Error(`第 ${index + 1} 行字幕格式无效`);
  const [, fh, fm, fs, th, tm, ts, content] = match;
  const from = Number(fh) * 3600 + Number(fm) * 60 + Number(fs);
  const to = Number(th) * 3600 + Number(tm) * 60 + Number(ts);
  if (!(to > from)) throw new Error(`第 ${index + 1} 行时间戳无效`);
  return { id: `L${String(index).padStart(5, '0')}`, from, to, content };
});

// 254 个字幕选项 + 1 个阶段外选项 = 255 个 choice 选项。
const stageSize = 254;
const stages = [];
for (let offset = 0; offset < cues.length; offset += stageSize) {
  const stage = cues.slice(offset, offset + stageSize);
  const first = stage[0].id;
  const last = stage.at(-1).id;
  const ids = Object.fromEntries(stage.map(cue => [cue.id, null]));
  const payload = {
    model: 'jev-latest',
    state: stage.map(cue => `${cue.id} [${cue.from.toFixed(2)}-${cue.to.toFixed(2)}] ${cue.content}`).join('\n'),
    questions: {
      has_promotion: {
        type: 'noul',
        instructions: '本阶段字幕是否包含明确的口播商业推广或赞助？普通剧情和非商业品牌提及不算。同一商家的价格、品质、售后、活动福利连续介绍算同一段推广。',
      },
      first_line_is_promotion: {
        type: 'noul',
        instructions: `本阶段第一句 ${first} 本身是否属于正在进行的口播商业推广？只看这句是否是推广的一部分，不要求推广从这句开始。`,
      },
      last_line_is_promotion: {
        type: 'noul',
        instructions: `本阶段最后一句 ${last} 本身是否属于正在进行的口播商业推广？只看这句是否是推广的一部分，不要求推广在这句结束。`,
      },
      multiple_promotions: {
        type: 'noul',
        instructions: '本阶段是否包含两段或以上彼此独立、之间已恢复正常非商业内容的商业口播推广？同一商家的价格、品质、售后及活动福利连续介绍只算一段。',
      },
      start: {
        type: 'choice',
        instructions: `选择本阶段第一段明确商业推广在本阶段内的第一句编号。如果本阶段无广告，或这段广告在 ${first} 之前就已开始，选择 NO_START。`,
        criteria: { NO_START: '本阶段没有广告，或第一段广告在本阶段开始前已经开始', ...ids },
      },
      end: {
        type: 'choice',
        instructions: `选择本阶段第一段明确商业推广在本阶段内的最后一句编号。同一商家的价格、品质、售后、活动福利连续介绍属于同一段，即使中间有短句或停顿也不要提前结束；以恢复正常非商业内容前的最后一句为准。如果本阶段无广告，或推广在 ${last} 之后仍继续，选择 NO_END。`,
        criteria: { NO_END: '本阶段没有广告，或第一段广告在本阶段结束后仍在继续', ...ids },
      },
    },
  };
  stages.push({ number: stages.length + 1, first, last, payload });
}

await mkdir(outputDir, { recursive: true });
const collection = {
  info: { name: '请空降｜254 条字幕分阶段 Jev 实验', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [],
  variable: [{ key: 'host', value: 'https://api.typesafe.ai' }, { key: 'api_key', value: '', type: 'secret' }],
};
for (const stage of stages) {
  const file = `${outputDir}/jev-stage-${stage.number}.json`;
  await writeFile(file, `${JSON.stringify(stage.payload, null, 2)}\n`);
  collection.item.push({
    name: `阶段 ${stage.number}：${stage.first}–${stage.last}`,
    request: {
      method: 'POST',
      header: [{ key: 'Content-Type', value: 'application/json' }],
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{api_key}}', type: 'string' }] },
      url: { raw: '{{host}}/v1/systemone', host: ['{{host}}'], path: ['v1', 'systemone'] },
      body: { mode: 'raw', raw: JSON.stringify(stage.payload, null, 2), options: { raw: { language: 'json' } } },
    },
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: [
      'const data = pm.response.json();',
      'console.log(pm.info.requestName, "HTTP", pm.response.code, "耗时 ms", pm.response.responseTime, "用量", data.usage);',
      'if (Number.isFinite(data.usage?.input_tokens)) console.log("估算成本 USD", data.usage.input_tokens * 0.042 / 1000000);',
      'for (const [name, answer] of Object.entries(data.answers || {})) {',
      '  if (answer.probabilities) console.log(name, answer.choice, Object.entries(answer.probabilities).sort((a,b) => b[1] - a[1]).slice(0, 5));',
      '  else console.log(name, answer.noul);',
      '}',
    ] } }],
  });
}
const collectionPath = `${outputDir}/jev-staged.postman_collection.json`;
await writeFile(collectionPath, `${JSON.stringify(collection, null, 2)}\n`);
console.log(JSON.stringify({ cues: cues.length, stages: stages.map(stage => ({ number: stage.number, first: stage.first, last: stage.last, choicesPerBoundary: Object.keys(stage.payload.questions.start.criteria).length })), collectionPath }, null, 2));
