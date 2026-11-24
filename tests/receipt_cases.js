// レシート読み取り（web/receipt.js）のテスト。`node tests/receipt_cases.js` で実行。
// pytest からも tests/test_receipt_parser.py 経由で呼ばれる。
const assert = require('assert');
const { parse } = require('../web/receipt.js');

const cases = [
  {
    name: '列型（iPhone のテキスト認識表示）: 品名の列と金額の列が分かれている',
    text: `TVBPサラダ油
たまみ6個入り
有料レジ袋
九条葱きざみメガ
TVBPかんたん便利な
258Ж
198×
3
198*
198×
小計
外税 8%対象額
外税8%
外税10%対象額
外税10%

* ﻿855
* ﻿852
* ﻿68

¥3
·0
合計
現金
お釣り
¥923
¥1,000
¥77`,
    lines: [
      ['TVBPサラダ油', 258, 1], ['たまみ6個入り', 198, 1], ['有料レジ袋', 3, 1],
      ['九条葱きざみメガ', 198, 1], ['TVBPかんたん便利な', 198, 1],
    ],
    total: 923,
  },
  {
    name: '1行型: 店名・日時・個数・値引き',
    text: `ドラッグストアA
2026/11/24 12:30
トイレットペーパー ×2 ¥796
洗濯洗剤 328※
のど飴 150
値引 30
小計 ¥1,244
合計 ¥1,244
お預り 2,000`,
    lines: [['トイレットペーパー', 796, 2], ['洗濯洗剤', 328, 1], ['のど飴', 150, 1], ['値引', -30, 1]],
    total: 1244,
  },
  {
    name: '1行型: 個数の行（2個×単198）が次の行にある',
    text: `スーパーB
TEL 03-1234-5678
牛乳 396
  2個 × 単198
食パン ¥158
レジNo.3 担当 山田
合計 ¥554`,
    lines: [['牛乳', 396, 2], ['食パン', 158, 1]],
    total: 554,
  },
  {
    name: '列型: 品名の前に店名・住所がある（品名を金額の直前から数える）',
    text: `○○マート 駅前店
東京都新宿区1-2-3
バナナ
ヨーグルト
120
158
合計
¥278`,
    lines: [['バナナ', 120, 1], ['ヨーグルト', 158, 1]],
    total: 278,
  },
];

let failed = 0;
for (const c of cases) {
  const r = parse(c.text);
  try {
    assert.deepStrictEqual(r.lines.map(l => [l.name, l.amount, l.qty]), c.lines);
    assert.strictEqual(r.total, c.total);
    console.log('ok   ', c.name);
  } catch (e) {
    failed++;
    console.log('FAIL ', c.name, '\n      got:', JSON.stringify(r));
  }
}
process.exit(failed ? 1 : 0);
