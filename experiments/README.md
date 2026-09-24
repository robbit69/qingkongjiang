# 整段字幕单次 Jev 请求实验

`jev-full-transcript.json` 由 588 条测试字幕生成。完整字幕只放在一次请求的 `state` 中；7 道问题同时判断是否有广告，以及第一段广告的起止句。由于单个 `choice` 的公开基数上限为 255，字幕编号分成 3 组，每组 196 个编号加 `NO_MATCH`，分别询问起点和终点。生成的 JSON 包含完整字幕，默认不会提交到 GitHub；先用下方脚本生成，再执行 curl 或导入 Postman。

## curl

在项目根目录执行（先在自己的终端设置 `TYPESAFE_API_KEY`，不要把密钥写进 JSON）：

```bash
curl --silent --show-error --fail-with-body \
  -o experiments/jev-full-transcript-response.json \
  -w 'HTTP %{http_code}; 总耗时 %{time_total}s\n' \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @experiments/jev-full-transcript.json \
  https://api.typesafe.ai/v1/systemone
```

响应中 `answers.has_promotion.noul` 是存在广告的概率。`start_1` 至 `start_3` 和 `end_1` 至 `end_3` 各有一个首选编号与 `probabilities`，可检查每组概率最高的若干编号和 `NO_MATCH`。`usage.input_tokens` 是计费输入 token；以 TypeSafe 当前公开单价计算，美元估算成本为 `input_tokens × 0.042 ÷ 1000000`。

## Postman

导入 `jev-full-transcript.postman_collection.json`，在集合变量中填写 `api_key`，然后运行唯一的请求。测试脚本会在 Postman Console 打印请求耗时、token 用量，以及每道选择题概率最高的 5 个选项。

这个请求只寻找**第一段**广告的一对边界。实验发现整段请求会把终点判早；正式扩展已经改为 254 条字幕一阶段，并在边界不稳时补问两个节点。重新生成此实验请求：

```bash
node scripts/make-jev-full-transcript-test.mjs '/path/to/captions.txt'
```
