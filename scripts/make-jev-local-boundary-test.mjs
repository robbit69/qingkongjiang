import { readFile, writeFile } from 'node:fs/promises';

const full = JSON.parse(await readFile('experiments/jev-full-transcript.json', 'utf8'));
const lines = full.state.split('\n').slice(50, 101);
const ids = Object.fromEntries(lines.map(line => [line.split(' ')[0], null]));
const payload = {
  model: 'jev-latest',
  state: lines.join('\n'),
  questions: {
    start: {
      type: 'choice',
      instructions: '选择这段字幕中明确商业口播推广的第一句编号。剧情铺垫不算；从开始介绍商品或商家并面向观众推荐的第一句算起。',
      criteria: ids,
    },
    end: {
      type: 'choice',
      instructions: '选择这段字幕中同一段商业口播推广的最后一句编号。同一商家的价格、品质、售后、活动福利连续介绍都算这一段，短暂停顿不算结束；恢复普通剧情之前的最后一句才是终点。',
      criteria: ids,
    },
  },
};
const outputPath = 'experiments/jev-local-boundary.json';
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, lines: lines.length, questions: Object.keys(payload.questions), choices: Object.keys(ids).length }));
