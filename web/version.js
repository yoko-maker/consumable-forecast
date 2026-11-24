// version.js — アプリのバージョン（画面と Service Worker の両方から読み込む）
// リリースのたびに APP_VERSION を上げ、APP_CHANGES に変更点を書く。
// バージョンを上げると sw.js のキャッシュ名が変わり、利用者に「更新する」が表示される。
self.APP_VERSION = '0.6.1';
self.APP_CHANGES = [
  'iPhone で画面上部のタブにモヤがかかって見える問題を直しました',
  'タブを画面上部に固定し、スクロールしてもいつでも切り替えられるようにしました',
];
