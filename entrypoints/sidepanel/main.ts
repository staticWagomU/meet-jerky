// サイドパネルはpopupとまったく同じUI・ロジックを流用する。
// popup/main.ts が末尾で init() を実行し #app へ描画するため、
// import するだけでサイドパネル文脈でもそのまま動作する。
import "../popup/main.ts";
// popup固有の固定サイズ(幅380px/高さ500px)をサイドパネル用に上書きする。
import "./style.css";
