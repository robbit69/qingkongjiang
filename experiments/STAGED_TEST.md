# 254 条字幕分阶段 Jev 实验

用户的整段请求返回 `has_promotion = 0.98`，起点首选 `L00061 = 0.52`、次选 `L00060 = 0.43`；终点首选 `L00068 = 0.61`，但 `L00069` 至 `L00080` 仍在介绍同一商家的品质、售后和优惠。因此整段请求不能直接用首选终点自动跳过。

新集合 `jev-staged.postman_collection.json` 有三个独立请求，每次只发送一个连续阶段：

| 阶段 | 字幕编号 | 数量 | 预期 |
| --- | --- | ---: | --- |
| 1 | L00000–L00253 | 254 | 包含完整广告，起点约 L00060／L00061，终点约 L00080 |
| 2 | L00254–L00507 | 254 | 无广告 |
| 3 | L00508–L00587 | 80 | 无广告 |

每阶段同时问：是否有广告、首句是否属于广告、末句是否属于广告、阶段内第一段广告的起点与终点。起止题各有最多 254 个编号加一个 `NO_START`／`NO_END`，恰好 255 个选项。

在 Postman 导入集合、填写集合变量 `api_key` 后，**先单独运行阶段 1**。Postman Console 会输出耗时、用量、估算成本和起止题概率最高的 5 个选项。若阶段 1 的终点仍明显早于 L00080，此方案不能直接取首选项用于自动跳过，需要局部二次判定或人工核对。

之后可运行阶段 2、3 验证无广告判断。若某个视频的广告跨越阶段边界，拼接逻辑应检查前一阶段末句与后一阶段首句是否都是广告；两侧都成立时，视为同一段。阶段首尾标志与起止编号互相矛盾、边界概率接近或一阶段包含多段广告时，应细分该阶段重新判定，不能机械拼接。

curl 测第一阶段（在项目根目录执行，密钥放在 `TYPESAFE_API_KEY` 环境变量）：

```bash
curl --silent --show-error --fail-with-body \
  -o experiments/jev-stage-1-response.json \
  -w 'HTTP %{http_code}; 总耗时 %{time_total}s\n' \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @experiments/jev-stage-1.json \
  https://api.typesafe.ai/v1/systemone
```
