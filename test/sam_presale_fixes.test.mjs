/**
 * SUN AND MOON 発売前改修（4課題）の実ファイル検証。
 * 実装が実ファイルに存在すること・旧機構の残骸が無いことを、仮定ではなく
 * ファイル内容そのもので検証する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("public/apps/sun-and-moon/index.html", "utf8");
const authJs = readFileSync("public/apps/sun-and-moon/auth-integration.js", "utf8");
const appStartTs = readFileSync("src/apps/sun-and-moon/app_start.ts", "utf8");

/* ---------- 課題1: 固有建物 Admin 専用化 ---------- */
test("[課題1] app-start が既存判定正本による isAdmin を後方互換で返す", () => {
  // 判定正本: 検証済み authUserId === env.ADMIN_AUTH_USER_ID（未設定時は非管理者）
  assert.match(appStartTs, /env\.ADMIN_AUTH_USER_ID && result\.auth\.authUserId === env\.ADMIN_AUTH_USER_ID/);
  assert.match(appStartTs, /jsonOk\(\{ started: true, isAdmin \}\)/);
  // 新しい独自判定を作っていない（requireAdmin の正本と同じ env 変数のみ参照）
  assert.doesNotMatch(appStartTs, /ADMIN_EMAIL|isAdminUser|adminList/);
});

test("[課題1] フロントは app-start の isAdmin で sm-admin を付与する（安全側デフォルト）", () => {
  assert.match(authJs, /body\.data\.isAdmin === true/);
  assert.match(authJs, /classList\.add\("sm-admin"\)/);
  assert.match(authJs, /window\.SM_IS_ADMIN = true/);
});

test("[課題1] 固有建物UI4系統が非Adminで非表示になる", () => {
  // CSS: 非Adminのみ隠す（Adminは元displayを維持）
  assert.match(html, /html:not\(\.sm-admin\) \.sm-admin-only \{ display: none !important; \}/);
  // 静的2系統: PC行・モバイルボタン
  assert.match(html, /<div class="ig sm-admin-only"[^>]*>\s*<label>プリセット対象を選択<\/label>/);
  assert.match(html, /<button id="mob-btn-landmark" class="sm-admin-only"/);
  // JS生成2系統: モバイルポップアップ・PCカスタムselect（開閉/描画とも）
  assert.match(html, /openMobSubjectPopup\([a-zA-Z_]+\)\{\n  if\([a-zA-Z_]+==='landmark' && !smIsAdmin\(\)\) return;/);
  assert.match(html, /function renderTargetCsd\(kind\)\{\n  if\(kind==='landmark' && !smIsAdmin\(\)\) return;/);
  assert.match(html, /function toggleTargetCsd\([a-zA-Z_]+\)\{\n  if\([a-zA-Z_]+==='landmark' && !smIsAdmin\(\)\) return;/);
});

test("[課題1] 選択関数の最終ガードと復元2経路（Pin/スポット）の遮断", () => {
  assert.match(html, /function selectLandmarkBuilding\(id\)\{\n  if\(!smIsAdmin\(\)\) return;/);
  // Pin 復元: 非Adminは building: を復元しない（既存missingと同じ穏当な扱い）
  assert.match(html, /smIsAdmin\(\) && LANDMARK_BUILDINGS\[tk\]\)\{ selectLandmarkBuilding\(tk\); return \{status:'restored', kind:'landmark'\}; \}/);
  // スポット復元: 非Adminは汎用文言（プリセットの存在を示唆しない）
  assert.match(html, /if\(smIsAdmin\(\) && LANDMARK_BUILDINGS\[tk\]\) selectLandmarkBuilding\(tk\);\n      else showHint\('保存時の対象が見つかりません（対象未選択で読み込みました）。'\);/);
});

/* ---------- 課題2: KMZ パスワード撤去 ---------- */
test("[課題2] 旧パスワード機構の残骸が一切無い", () => {
  for (const k of ["modal-kml-auth", "_KH", "openKmlAuthModal", "checkKmlPW", "kmlAuth", "_kmlPendingFn", "kml-pw"]) {
    assert.ok(!html.includes(k), `残骸: ${k}`);
  }
});

test("[課題2] 入口は downloadPortraitKmz 直呼びへ変更されている", () => {
  assert.match(html, /onclick="closeModal\('modal-ge'\);downloadPortraitKmz\(\);"/);
});

/* ---------- 課題3: KMZ 等価ズーム A+C ---------- */
test("[課題3] A: ツアー2は virt 基準で天体を再配置し、t2 の Location/Orientation が positions_t2 を参照する", () => {
  // P0修正後: 配置方向は「光軸相対 tan × magT」の相似方向（azV/altV）。詳細な幾何検証は
  // sam_tour2_projection.test.mjs が行い、ここでは virt 基準配置と参照の配線を検証する。
  assert.match(html, /const positions_t2 = steps\.map\(s_=>\{/);
  assert.match(html, /const \[bLat,bLng\]=destPoint\(virtLat,virtLng,azV,bodyDistKmT2\);/);
  assert.match(html, /return \{lat:bLat,lng:bLng,altitude:bAlt,azV,altV\};/);
  // 初期値・ループ更新とも positions_t2 / virt 基準 heading
  assert.match(html, /<Location id="body_loc_t2">\s*\n\s*<longitude>\$\{positions_t2\[0\]\.lng\}/);
  assert.match(html, /targetId="body_loc_t2">\s*\n\s*<longitude>\$\{positions_t2\[i\]\.lng\.toFixed\(7\)\}/);
  assert.match(html, /body_ori_t2"><heading>\$\{\(\(\(brng\(positions_t2\[0\]\.lat, positions_t2\[0\]\.lng, virtLat, virtLng\)/);
  assert.match(html, /brng\(positions_t2\[i\]\.lat, positions_t2\[i\]\.lng, virtLat, virtLng\)/);
});

test("[課題3] ツアー1（画角再現）は不変: body_loc/body_ori は撮影地点基準 positions のまま", () => {
  assert.match(html, /targetId="body_loc">\s*\n\s*<longitude>\$\{p\.lng\.toFixed\(7\)\}/);
  assert.match(html, /Orientation targetId="body_ori">\s*\n\s*<heading>\$\{\(\(\(brng\(p\.lat, p\.lng, sLat, sLng\)/);
  // ツアー1の初期 Camera / FlyTo は撮影地点
  assert.match(html, /<Camera>\s*\n\s*<longitude>\$\{sLng\}<\/longitude>\s*\n\s*<latitude>\$\{sLat\}<\/latitude>/);
});

test("[課題3] C: magT による相対サイズ維持と FOV 定数一元化・旧補正式の撤去", () => {
  // 3D前進量 virtMoveM を直接用いた magT と、天体サイズ式 S=2R·tan(δ/2)·magT
  assert.match(html, /const magT = \(virtRatio<1\) \? \(dist3dM\/\(dist3dM - virtMoveM\)\) : 1;/);
  assert.match(html, /bodySizeM_t2 = 2\*bodyDistKmT2\*1000\*Math\.tan\(angDiamDeg\/2\*Math\.PI\/180\)\*magT/);
  // 誤っていた旧式（shortScale 直掛け）が残っていない
  assert.ok(!/bodySizeM_t2[^\n]*\*shortScale/.test(html), "shortScale 直掛けの旧式が無い");
  // 旧 distRatioT2（位置無補正の補償）と FOV ハードコードは撤去
  assert.ok(!html.includes("distRatioT2"), "旧 distRatioT2 が残っていない");
  assert.ok(!html.includes("<gx:horizFov>10.29</gx:horizFov>"), "FOV ハードコードが残っていない");
  assert.match(html, /<gx:horizFov>\$\{fovLimit\.toFixed\(2\)\}<\/gx:horizFov>/);
});

test("[課題3] 検証用中間値 __smKmzDebug（maxAzErr/maxAltErr）が格納される", () => {
  assert.match(html, /window\.__smKmzDebug=\{\n\s*virtRatio, moveM:virtMoveM, moveH:virtMoveH, clamped:virtClamped,/);
  assert.match(html, /targetScale:_kT, bodyScale:_kB, scaleDiff:Math\.abs\(_kT-_kB\),/);
  assert.match(html, /maxAzErrDeg:_maxAzErr, maxAltErrDeg:_maxAltErr/);
});

/* ---------- 課題4: 円錐台の上面幅 ---------- */
test("[課題4] 入出力4点＋新規リセットが実装されている（topWidth>=0・上限なし）", () => {
  // 1) shape変更でfrustum時のみ上面幅行を表示
  assert.match(html, /const showTopW=\(type==='building' && shape==='frustum'\);\n  document\.getElementById\('subject-topwidth-row'\)\.style\.display=showTopW\?'':'none';/);
  // 2) 保存: frustum時のみ topWidth（>=0 クランプ・上限制約なし）。他形状は undefined で自然消滅
  assert.match(html, /extra\.topWidth=\(shape==='frustum'\) \? Math\.max\(0, isNaN\(twRaw\)\?0:twRaw\) : undefined;/);
  assert.ok(!/topWidth[^\n]*Math\.min\(/.test(html), "上限（width以下）の制約を設けていない");
  // 3) 編集復元: 0 を有効値として復元（||'' を使わない）
  assert.match(html, /\('inp-subject-topwidth'\)\.value=\(s\.topWidth===undefined\|\|s\.topWidth===null\)\?'':s\.topWidth;/);
  // 4) subjectAsT: 計算対象形式へ伝搬（未保存データは0フォールバック=後方互換）
  assert.match(html, /topWidth: isBuilding \? \(s\.topWidth\|\|0\) : 0,/);
  // 5) 新規フォームリセット
  assert.match(html, /\('inp-subject-shape'\)\.value='cylinder';\n  document\.getElementById\('inp-subject-topwidth'\)\.value='';/);
});

test("[課題4] 既存描画側（プレビュー/KML）は不変のまま topWidth を参照している", () => {
  assert.match(html, /const N=24, r1=tgW\/2, r2=\(ct\.topWidth\|\|0\)\/2;/);
  assert.match(html, /const r2Km=\(\(subj\.topWidth\|\|0\)\/2\)\/1000;/);
});

/* ============ 発売前最終調整（項目5〜8）の実ファイル検証 ============ */
const htmlB = readFileSync("public/apps/sun-and-moon/index.html", "utf8");
const siteCssB = readFileSync("public/assets/site.css", "utf8");

test("[項目5] スマホ地図上の太陽/月トグルが既存 setSunsetMode を再利用している", () => {
  // ボタンは既存処理へ直結（新ロジックなし）
  assert.match(htmlB, /<button id="map-body-toggle" onclick="setSunsetMode\(!sunsetMode\)"/);
  // PC 既定は非表示（発売前実機修正で右端縦列へ移動後の現行 CSS。空白を許容）
  assert.match(htmlB, /#map-body-toggle\{\s*display:none;\s*\}/);
  // スマホ（max-width:600px）でのみ表示。衛星ボタン直下の右端縦列に flex 配置する現行仕様。
  assert.match(htmlB, /@media \(max-width:600px\)\{[\s\S]*?#map-body-toggle\{\s*display:flex\s*!important;/);
  // 状態同期は setSunsetMode 内で一元管理（太陽=☀/月=☾が判別可能）
  assert.match(htmlB, /mbt\.textContent=v\?'☀ 太陽':'☾ 月';/);
  // sunsetMode の代入箇所が増えていない（宣言+setSunsetMode内のみ＝状態一元）
  const assigns = htmlB.match(/(?<![=!<>])sunsetMode\s*=(?!=)/g) || [];
  assert.equal(assigns.length, 2, `sunsetMode代入は宣言+setSunsetMode内の2箇所のみ（実際 ${assigns.length}）`);
});

test("[項目7] 稜線取得は地点+対象が揃うまで開始されない（取得0回保証）", () => {
  // 共有ヘルパは既存の選択状態関数を再利用
  assert.match(htmlB, /function smHasTarget\(\)\{ return !!\(currentLandmarkBuilding\(\)\|\|curSubjectAsT\(\)\); \}/);
  // fetch系2関数とも、条件不足時は警告すら出さない完全no-op（実機E2E修正2）
  for (const fn of ["fetchRidgeNear", "fetchRidgeFar"]) {
    const i = htmlB.indexOf(`async function ${fn}(){`);
    assert.ok(i >= 0, fn);
    const head = htmlB.slice(i, i + 420);
    const gLoc = head.indexOf("if(sLat===null||sLng===null) return;");
    const gTgt = head.indexOf("if(!smHasTarget()) return;");
    const firstWork = head.indexOf("querySelectorAll");
    assert.ok(gLoc > 0 && gTgt > gLoc, `${fn}: 地点→対象の順で静かにreturn`);
    assert.ok(firstWork > gTgt, `${fn}: 一切の処理より前`);
    assert.ok(!head.slice(0, firstWork).includes("alert"), `${fn}: 条件不足時にalertなし`);
  }
  // 木20m: 設定値・表示更新後、対象未設定なら再描画も稜線破棄も発火させない
  const treeFn = htmlB.match(/function cycleRidgeTreeH\(\)\{[\s\S]*?\n\}/)[0];
  const tGuard = treeFn.indexOf("if(!smHasTarget()) return;");
  const tDisp = treeFn.indexOf("btn-ridge-tree");
  const tClear = treeFn.indexOf("clearRidgeline()");
  assert.ok(tGuard > 0 && tDisp > 0 && tClear > 0, "構成要素が存在");
  assert.ok(tDisp < tGuard && tGuard < tClear, "表示更新→ガード→（対象ありのみ）破棄/再描画の順");
  // 近〜km/遠〜km は設定値+表示のみ（fetch・再描画なし）を維持
  const nearKm = htmlB.match(/function cycleRidgeNearKm\(\)\{[\s\S]*?\n\}/)[0];
  const farKm = htmlB.match(/function cycleRidgeDist\(\)\{[\s\S]*?\n\}/)[0];
  for (const seg of [nearKm, farKm]) {
    assert.doesNotMatch(seg, /fetch|Redraw|layout|onPick/);
  }
});

test("[項目8-1] オフセット操作UIの色規則が統一されている（0以上=黄/負=ピンク・地図ラベル非適用）", () => {
  assert.match(htmlB, /function _ofsUiColor\(v\)\{ return v>=0 \? 'var\(--ac\)' : '#f88'; \}/);
  // 撮影地点: 旧「0=グレー」分岐が撤廃され共通規則へ
  assert.match(htmlB, /el\.style\.color = _ofsUiColor\(elevOffset\);/);
  assert.doesNotMatch(htmlB, /elevOffset===0 \? 'var\(--sub\)'/);
  // 地図ラベル側（E:表記のofsHtml）は従来式のまま（青系体系を不用意に変更しない）
  assert.match(htmlB, /const ofsHtml = ofsTxt \? ` <span class="u" style="color:\$\{elevOffset>0\?'var\(--ac\)':'#f88'\};">/);
});

test("[項目8-2] 撮影地点オフセットの数値部が既存numericPadで直接入力できる", () => {
  assert.match(htmlB, /id="elev-offset-disp" onclick="openElevOffsetPad\(\)"/);
  assert.match(htmlB, /function openElevOffsetPad\(\)\{[\s\S]{0,700}onCommit:\(n\)=>\{ shiftElevOffset\(n - elevOffset\); \}/);
  const pad = htmlB.match(/function openElevOffsetPad\(\)\{[\s\S]{0,700}?\}\);/)[0];
  assert.match(pad, /allowNegative:true, allowDecimal:true/);
  assert.match(pad, /min:\(\)=>-999/);
});

test("[対象オフセット] targetOffset(セッション補正)は廃止され、対象データelevOffsetへ一本化", () => {
  // セッション変数・操作UI・パッドの残骸なし（コメントのみ許容）
  assert.ok(!/let targetOffset/.test(htmlB), "グローバル宣言なし");
  assert.ok(!htmlB.includes("shiftSubjectOffset"), "shiftSubjectOffsetなし");
  assert.ok(!htmlB.includes("openSubjectOffsetPad"), "openSubjectOffsetPadなし");
  assert.ok(!htmlB.includes('id="subject-offset-ui"'), "パネルUI行なし");
  assert.ok(!htmlB.includes('id="subject-offset-disp"'), "表示要素なし");
  // 登録フォーム最下部にオフセット行（常時表示・保存・復元・リセット）
  assert.match(htmlB, /id="subject-offset-row"/);
  assert.match(htmlB, /<label>オフセット \[m\]/);
  assert.match(htmlB, /id="inp-subject-offset" placeholder="0" step="0\.1" value="0"/);
  assert.match(htmlB, /extra\.elevOffset=Math\.round\(\(isNaN\(ofRaw\)\?0:ofRaw\)\*10\)\/10;/);
  assert.match(htmlB, /getElementById\('inp-subject-offset'\)\.value=\(s\.elevOffset===undefined\|\|s\.elevOffset===null\)\?0:s\.elevOffset;/);
  assert.match(htmlB, /getElementById\('inp-subject-offset'\)\.value=0;/);
  // 適用: 全種別で elev+elevOffset（未設定=0で後方互換）
  assert.match(htmlB, /function subjectTotalElev\(s\)\{\n  return \(s\.elev\|\|0\) \+ \(s\.elevOffset\|\|0\);\n\}/);
  // KMZは _ct().elev（elevOffset反映済み）を参照
  assert.match(htmlB, /const targetTopAlt=\(t\.elev\|\|0\)\+\(t\.h\|\|0\);/);
  // UI順序: オフセットは最下部（上面幅・正面方位より後）
  const iTW = htmlB.indexOf('id="subject-topwidth-row"');
  const iFA = htmlB.indexOf('id="subject-frontaz-row"');
  const iOF = htmlB.indexOf('id="subject-offset-row"');
  assert.ok(iTW < iFA && iFA < iOF, "上面幅→正面方位→オフセットの順");
});

test("[項目8-4] numericPad が呼出元ごとの制約（負数・小数）を持ち既存呼出は不変", () => {
  // '-' は許可時のみ・先頭のみ、'.' は許可時のみ・1個・小数第1位まで
  assert.match(htmlB, /if\(k==='-'\)\{[\s\S]{0,200}if\(!_npCfg\.allowNegative\) return;/);
  assert.match(htmlB, /if\(k==='\.'\)\{[\s\S]{0,200}if\(!_npCfg\.allowDecimal\) return;/);
  assert.match(htmlB, /if\(\/\\\.\\d\$\/\.test\(_npBuf\)\) return; \/\/ 小数第1位までに制限/);
  // 確定時は小数第1位へ丸め、パースはcfg駆動（既存整数呼出はparseIntのまま）
  assert.match(htmlB, /_npCfg&&_npCfg\.allowDecimal \? parseFloat\(buf\) : parseInt\(buf,10\)/);
  assert.match(htmlB, /if\(cfg\.allowDecimal&&isFinite\(n\)\) n=Math\.round\(n\*10\)\/10;/);
  // パッドUIにキーが存在し、許可時のみ可視化
  assert.match(htmlB, /id="np-key-neg" onclick="npInput\('-'\)"/);
  assert.match(htmlB, /id="np-key-dot" onclick="npInput\('\.'\)"/);
  assert.match(htmlB, /kNeg\.style\.visibility=cfg\.allowNegative\?'visible':'hidden';/);
  // 三脚高（既存呼出）は制約未指定＝従来どおり
  const tripod = htmlB.match(/function openTripodPad\(\)\{[\s\S]{0,600}?\}\);/)[0];
  assert.doesNotMatch(tripod, /allowNegative|allowDecimal/);
});

test("[項目6] HOMEヒーローはスマホのみ縦縮小・下側クロップ（PC不変・画像非変形）", () => {
  // PC側の高さ定義は不変
  assert.ok(siteCssB.includes("height: clamp(355px, 46vh, 475px);"), "PC hero高さ不変");
  // モバイル: 約70%へ縮小＋sceneは上基準118%高（下側の水面帯だけをクロップ）
  const mi = siteCssB.indexOf("@media (max-width: 720px) {", siteCssB.indexOf(".hero {"));
  assert.ok(mi >= 0, "hero用の720pxメディアブロック");
  const mob = siteCssB.slice(mi, siteCssB.indexOf("\n}", siteCssB.indexOf(".hero .hero-sub", mi)) + 2);
  assert.ok(mob.includes(".hero { height: clamp(217px, 30vh, 270px); }"), "モバイル高さ≈70%");
  assert.ok(mob.includes(".hero-scene { inset: auto; top: 0; left: 0; width: 100%; height: 118%; }"), "scene上基準クロップ");
  // 変形につながる transform/scale を使っていない
  assert.doesNotMatch(mob, /scale|stretch/);
});


test("[実機E2E修正1] 対象登録UIは 種別→形状→高さ→底面幅→上面幅 の順・ラベルは底面幅", () => {
  const iType = htmlB.indexOf('id="inp-subject-type"');
  const iShape = htmlB.indexOf('id="subject-shape-row"');
  const iH = htmlB.indexOf('id="subject-height-row"');
  const iW = htmlB.indexOf('id="subject-width-row"');
  const iTW = htmlB.indexOf('id="subject-topwidth-row"');
  assert.ok(iType > 0 && iType < iShape, "種別→形状");
  assert.ok(iShape < iH && iH < iW && iW < iTW, "形状→高さ→底面幅→上面幅");
  assert.match(htmlB, /<label>底面幅 \[m\]　※任意<\/label>/);
  assert.ok(!htmlB.includes("<label>幅 [m]"), "旧ラベル『幅』が残っていない");
  // topWidth の保存・復元・伝搬（rev18実装）は不変
  assert.match(htmlB, /extra\.topWidth=\(shape==='frustum'\)/);
  assert.match(htmlB, /topWidth: isBuilding \? \(s\.topWidth\|\|0\) : 0,/);
});
