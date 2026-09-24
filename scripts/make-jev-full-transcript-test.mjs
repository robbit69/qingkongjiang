import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const inputPath = process.argv[2];
const outputPath = resolve(process.argv[3] || 'experiments/jev-full-transcript.json');
if (!inputPath) {
  console.error('用法：node scripts/make-jev-full-transcript-test.mjs <字幕文本文件> [输出 JSON 文件]');
  process.exit(1);
}

const source = await readFile(inputPath, 'utf8');
const cuePattern = /^\[(\d+):(\d+):(\d+(?:\.\d+)?)–(\d+):(\d+):(\d+(?:\.\d+)?)\]\s*(.+)$/;
const cues = source.split(/\r?\n/).filter(Boolean).map((raw, index) => {
  const match = raw.match(cuePattern);
  if (!match) throw new Error(`第 ${index + 1} 行不是预期的字幕格式`);
  const [, fromHour, fromMinute, fromSecond, toHour, toMinute, toSecond, content] = match;
  const from = Number(fromHour) * 3600 + Number(fromMinute) * 60 + Number(fromSecond);
  const to = Number(toHour) * 3600 + Number(toMinute) * 60 + Number(toSecond);
  if (!(to > from)) throw new Error(`第 ${index + 1} 行时间戳无效`);
  return { id: `L${String(index).padStart(5, '0')}`, from, to, content };
});
if (!cues.length) throw new Error('字幕文件为空');

const questions = {
  has_promotion: {
    type: 'noul',
    instructions: '整段字幕中是否存在明确的口播商业推广或赞助介绍？普通内容介绍、引用品牌或非商业提及不算。',
    criteria: { true: '出现向观众推广商品、服务、品牌或赞助商的连续口播', false: '没有明确商业推广口播' },
  },
};

// Jev 公布的 choice 基数上限为 255；每组最多 196 个编号，另加 NO_MATCH。
const groupSize = 196;
for (let offset = 0; offset < cues.length; offset += groupSize) {
  const group = cues.slice(offset, offset + groupSize);
  const groupNumber = Math.floor(offset / groupSize) + 1;
  const first = group[0].id;
  const last = group.at(-1).id;
  const ids = Object.fromEntries(group.map(cue => [cue.id, null]));
  questions[`start_${groupNumber}`] = {
    type: 'choice',
    instructions: `找出整段字幕中第一段明确商业推广的开始句。如果开始句在 ${first} 至 ${last} 内，选择该句编号；整段无广告或开始句不在本组，则选 NO_MATCH。`,
    criteria: { NO_MATCH: '整段无广告，或第一段推广的开始句不在本组', ...ids },
  };
  questions[`end_${groupNumber}`] = {
    type: 'choice',
    instructions: `找出整段字幕中第一段明确商业推广的结束句。如果结束句在 ${first} 至 ${last} 内，选择该句编号；整段无广告或结束句不在本组，则选 NO_MATCH。`,
    criteria: { NO_MATCH: '整段无广告，或第一段推广的结束句不在本组', ...ids },
  };
}

const state = cues.map(cue => `${cue.id} [${cue.from.toFixed(2)}-${cue.to.toFixed(2)}] ${cue.content}`).join('\n');
const payload = { model: 'jev-latest', state, questions };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

const collection = {
  info: { name: '请空降｜整段字幕 Jev 单次请求实验', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{
    name: `${cues.length} 条字幕：第一段广告起止句`,
    request: {
      method: 'POST',
      header: [{ key: 'Content-Type', value: 'application/json' }],
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{api_key}}', type: 'string' }] },
      url: { raw: '{{host}}/v1/systemone', host: ['{{host}}'], path: ['v1', 'systemone'] },
      body: { mode: 'raw', raw: JSON.stringify(payload, null, 2), options: { raw: { language: 'json' } } },
    },
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: [
      'const data = pm.response.json();',
      'console.log("HTTP", pm.response.code, "耗时 ms", pm.response.responseTime, "用量", data.usage);',
      'if (Number.isFinite(data.usage?.input_tokens)) console.log("按 TypeSafe 公布价格估算成本 USD", data.usage.input_tokens * 0.042 / 1000000);',
      'for (const [name, answer] of Object.entries(data.answers || {})) {',
      '  if (answer.probabilities) console.log(name, answer.choice, Object.entries(answer.probabilities).sort((a,b) => b[1] - a[1]).slice(0, 5));',
      '  else console.log(name, answer.noul);',
      '}',
    ] } }],
  }],
  variable: [{ key: 'host', value: 'https://api.typesafe.ai' }, { key: 'api_key', value: '', type: 'secret' }],
};
const collectionPath = outputPath.replace(/\.json$/, '.postman_collection.json');
await writeFile(collectionPath, `${JSON.stringify(collection, null, 2)}\n`);
console.log(JSON.stringify({ cues: cues.length, groups: Math.ceil(cues.length / groupSize), questions: Object.keys(questions).length, stateCharacters: state.length, maxChoicesPerQuestion: Math.min(groupSize, cues.length) + 1, outputPath, collectionPath }, null, 2));
