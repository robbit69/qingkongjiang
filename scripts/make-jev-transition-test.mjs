import { readFile, writeFile } from 'node:fs/promises';

for (const [source, target] of [
  ['experiments/jev-stage-1.json', 'experiments/jev-transition-full.json'],
  ['experiments/jev-seam-2.json', 'experiments/jev-transition-seam.json'],
]) {
  const payload = JSON.parse(await readFile(source, 'utf8'));
  payload.questions.end.instructions = '选择本阶段第一段口播商业推广结束后，第一句恢复普通非商业内容的字幕编号。选中的这一句本身不是广告；同一商家的价格、品质、售后、活动福利都属于同一段推广，中间短句或停顿不算结束。若本阶段没有广告，或广告持续到本阶段最后一句而尚未恢复正常内容，则选择 NO_END。';
  payload.questions.end.criteria.NO_END = '本阶段没有广告，或广告在本阶段没有结束并恢复正常内容';
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ source, target, cues: payload.state.split('\n').length, endOptions: Object.keys(payload.questions.end.criteria).length }));
}
