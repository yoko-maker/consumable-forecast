// receipt.js — レシートの文字（スマホの文字認識でコピーしたもの）から購入品と合計を読み取る
//
// 文字認識の結果は2通りの形で来る。
//   1行型:  「牛乳 198」のように品名と金額が同じ行にある
//   列型:   品名だけの行が続いたあと、金額だけの行が同じ順番で続く
//           （レシートを「品名の列」「金額の列」に分けて読んだ場合。iPhone のテキスト認識表示で多い）
// どちらも読めるように、行を「品名」「金額」「品名＋金額」「個数」に分類し、
// 品名の並びとその直後の金額の並びを順番どおりに組み合わせる。
//
// 小計・合計などが出てきたところから下はフッターとして扱い、合計金額だけを取り出す。

const ReceiptParser = (() => {
  // ここから下はフッター（小計・税・合計・支払い）
  const FOOTER = /小計|合計|総計|お釣|釣銭|おつり|預り|預かり|お預|対象額|税率|内税|外税|消費税|現金|クレジット|電子マネー|支払|買上点数|お買上|点数/;
  // 品目ではない行（店の情報・日時など）
  const NOISE = /領収|TEL|電話|登録番号|レジ\s*(?:No|番号|#|\d)|担当|責任者|ありがとう|No\.|伝票|〒|https?:|www\.|\d{2,4}\s*[\/年.\-]\s*\d{1,2}\s*[\/月.\-]\s*\d{1,2}|\d{1,2}:\d{2}/i;
  const HAS_WORD = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z]/u;
  // 金額の後ろに付く印（軽減税率の※・*、文字認識の誤読 Ж など）
  const MARK = String.raw`(?:[※*＊×xX軽外内非](?:税)?|[Ѐ-ӿ])`;
  const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
  const PRICE_ONLY = new RegExp(String.raw`^([-−▲△]?)\s*[¥￥\\]?\s*([-−▲△]?)\s*${NUM}\s*円?\s*${MARK}{0,2}$`, 'u');
  const NAME_PRICE = new RegExp(String.raw`^(.*?\S)\s*([-−▲△]?)\s*[¥￥\\]\s*${NUM}\s*円?\s*${MARK}{0,2}$|^(.*?\S)\s+([-−▲△]?)\s*${NUM}\s*円?\s*${MARK}{0,2}$|^(.*?[^\d\s,])([-−▲△]?)${NUM}\s*円?\s*${MARK}{1,2}$`, 'u');
  // 「2個 × 単198」「@198 × 2」のような個数の行
  const QTY_LINE = /^(\d+)\s*(?:個|コ|点|本|袋|P|パック)?\s*[x×X*＊]\s*(?:単|@|＠)?\s*[¥￥]?\s*\d[\d,]*\s*$|^[@＠単]\s*[¥￥]?\s*\d[\d,]*\s*[x×X*＊]\s*(\d+)\s*(?:個|コ|点)?\s*$/;
  const DISCOUNT = /値引|割引|クーポン/;

  function clean(raw) {
    return raw.normalize('NFKC')
      .replace(/[​-‍⁠﻿]/g, '')
      .trim()
      .replace(/^[*＊・·•]+\s*/, '')   // 行頭の「* 」「· 」など（文字認識が付ける印）
      .trim();
  }

  const toNum = s => parseInt(s.replace(/,/g, ''), 10);

  // 行を分類する
  function tokenize(lines) {
    const tokens = [];
    lines.forEach((line, idx) => {
      if (!line || NOISE.test(line)) return;
      const q = line.match(QTY_LINE);
      if (q) { tokens.push({ type: 'qty', qty: toNum(q[1] || q[2]), idx }); return; }
      const p = line.match(PRICE_ONLY);
      if (p) { tokens.push({ type: 'price', amount: toNum(p[3]) * (p[1] || p[2] ? -1 : 1), idx }); return; }
      const m = line.match(NAME_PRICE);
      if (m) {
        const name = (m[1] ?? m[4] ?? m[7]).trim();
        const sign = m[2] ?? m[5] ?? m[8];
        const num = m[3] ?? m[6] ?? m[9];
        if (HAS_WORD.test(name)) {
          tokens.push({ type: 'item', text: name, amount: toNum(num) * (sign ? -1 : 1), idx });
          return;
        }
      }
      if (HAS_WORD.test(line)) tokens.push({ type: 'name', text: line, idx });
    });
    // 個数の行は直前の品名・品目に付ける
    const out = [];
    for (const t of tokens) {
      if (t.type === 'qty') {
        const prev = out[out.length - 1];
        if (prev && (prev.type === 'item' || prev.type === 'name')) prev.qty = t.qty;
        continue;
      }
      out.push(t);
    }
    return out;
  }

  // 「品名の並び」と直後の「金額の並び」を組み合わせる。
  // alignEnd: 数が合わないとき、品名の並びの後ろ側（金額の直前）を使う（店名などを除くため）
  function pairRuns(tokens, alignEnd) {
    const pairs = [];
    let unpaired = 0;
    let i = 0;
    while (i < tokens.length) {
      if (tokens[i].type !== 'name') { i++; continue; }
      const names = [];
      while (i < tokens.length && tokens[i].type === 'name') names.push(tokens[i++]);
      const prices = [];
      while (i < tokens.length && tokens[i].type === 'price') prices.push(tokens[i++]);
      if (!prices.length) continue;
      const k = Math.min(names.length, prices.length);
      const ns = alignEnd ? names.slice(names.length - k) : names.slice(0, k);
      for (let j = 0; j < k; j++) pairs.push({ ...ns[j], amount: prices[j].amount });
      if (prices.length > names.length) unpaired += prices.length - names.length;
    }
    return { pairs, unpaired };
  }

  function toLine(t) {
    let name = t.text;
    let qty = t.qty || 1;
    // 品名の後ろの「×2」「2個」
    const q = name.match(/^(.*?)\s*[x×X*＊]\s*(\d+)\s*(?:個|点)?$/) || name.match(/^(.*?)\s+(\d+)\s*(?:個|点)$/);
    if (q && q[1] && HAS_WORD.test(q[1])) { name = q[1].trim(); qty = toNum(q[2]) || qty; }
    name = name.replace(/\s*[¥￥\\]$/, '').trim();
    const amount = DISCOUNT.test(name) && t.amount > 0 ? -t.amount : t.amount;
    return { name, amount, qty: DISCOUNT.test(name) ? 1 : qty };
  }

  function findTotal(tokens) {
    const isTotal = s => /合計/.test(s) && !/小計|対象/.test(s);
    const direct = tokens.find(t => t.type === 'item' && isTotal(t.text));
    if (direct) return direct.amount;
    const { pairs } = pairRuns(tokens, false);
    const hit = pairs.find(p => isTotal(p.text));
    return hit ? hit.amount : null;
  }

  // 戻り値: { lines: [{ name, amount, qty }], total: 合計（見つからなければ null）, unpaired: 組にできなかった金額の数 }
  function parse(text) {
    const lines = String(text || '').split(/\r?\n/).map(clean);
    let footerAt = lines.findIndex(l => FOOTER.test(l));
    if (footerAt < 0) footerAt = lines.length;
    const body = tokenize(lines.slice(0, footerAt));
    const footer = tokenize(lines.slice(footerAt));

    const { pairs, unpaired } = pairRuns(body, true);
    const items = [...body.filter(t => t.type === 'item'), ...pairs].sort((a, b) => a.idx - b.idx);
    return { lines: items.map(toLine), total: findTotal(footer), unpaired };
  }

  return { parse };
})();

if (typeof module !== 'undefined') module.exports = ReceiptParser;
