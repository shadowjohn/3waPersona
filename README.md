# 3waPersona

可設定各種用途的 AI 人物。第一個角色 Mio（米歐），先完成自然說話的嘴型與表情。

## EdgeTTS 嘴型與表情原型

第一版聚焦美少女卡通人物頭部說話：輸入繁體中文，使用 EdgeTTS 台灣女聲，播放時同步控制嘴型、表情、眨眼、視線及輕微頭部動作。這一版沒有接對話模型或面試流程。

## 啟動

需要 Python 3.10 以上，使用目前的 Edge 或 Chrome。

- Windows：clone 後雙擊 `start.bat`。第一次會建立虛擬環境、安裝套件及下載驗證渲染器。
- Linux / macOS：在目錄執行 `bash start.sh`。
- 開啟 http://127.0.0.1:8765 ，輸入文字後按「開始說話」。`Ctrl+Enter` 也能開始。
- 「停止」會停止音訊、取消等待中的前端請求並立即閉嘴。重新說話時不會播放先前被取消的回應。

也可以手動啟動：

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate
python -m pip install -r requirements.txt
python setup_assets.py
python server.py
```

角色使用版本庫內的 `data/Mio 米歐.vrm`。首次啟動會下載固定版本的 JavaScript 渲染器，逐一驗證 SHA-256，之後由本機供應；說話時需要連線到 Microsoft 的 EdgeTTS 線上服務。輸入文字會傳至該服務。本機程式只保留最近十二筆語音在記憶體，關閉後清空。預設只監聽本機 `127.0.0.1`。

## 嘴型怎麼動

1. EdgeTTS 實際音訊及 `WordBoundary` 時間是基準。
2. 依中文拼音聲母、韻母，估算 A / I / U / E / O 的嘴型順序；複合母音會轉換嘴型，b / p / m 開頭保留短暫閉唇。
3. 由下載後的真實音訊計算 20ms RMS 包絡，停頓或靜音時閉嘴。
4. 嘴型用前後形狀混合及平滑過渡，與字幕共享音訊播放時鐘；補償音訊輸出延遲。
5. 表情採低幅度混合，眨眼、視線、小幅擺頭各自控制。可選平靜、微笑、思考、驚訝，也能關閉輔助動作。

**精度範圍：**EdgeTTS 詞界不是逐音素時間或 viseme ID；此版是「詞界＋拼音推估＋真實音量」的近似嘴型。中文多音字、夾雜英文、快速連音及部分唇齒音仍可能有誤。自然程度需實際觀察；需要更準確時，可替換 `visemes.py` 接音素強制對齊，前端及角色不必重做。

## 微調

- 嘴型幅度：預設 1.0；可調整張嘴程度。
- 嘴型時間偏移：正值提前、負值延後，可補償不同喇叭或藍牙裝置延遲。
- 語速：-30% 至 +30%。
- 兩個聲音：`zh-TW-HsiaoChenNeural`、`zh-TW-HsiaoYuNeural`。
- 預設不修改音高，保留 TTS 原本的聲線。

## 驗證

```bash
python -m unittest discover -s tests -v
```

口型時間軸測試涵蓋詞界範圍、靜音間隔、閉唇聲母與五種母音。開發時另以真實 EdgeTTS 音訊進行桌面及手機尺寸的瀏覽器播放驗證；Windows 啟動腳本仍需在 Windows 實機確認。

## 檔案與後續接法

- `server.py`：`POST /api/tts` 接收 `text / voice / rate / pitch`；回傳 Base64 MP3、詞界及嘴型時間軸。產生失敗會明確回報，不以假音訊代替。
- `visemes.py`：中文嘴型近似時間軸。
- `public/app.js`：角色控制、音訊時鐘、表情及嘴型平滑。`window.avatarHead.speak()` / `.stop()` / `.getState()` 可用於後續整合。
- `data/Mio 米歐.vrm`：羽山製作的 Mio 模型，由 `GET /api/character` 提供，具有五母音、表情及眨眼變形。可以替換成符合 VRM 規範的模型，再調整鏡頭。
- 之後 LLM 回答只需填入試說文字，呼叫同一說話入口；本版先驗證說話表現。

## 來源與授權

- 角色：羽山 / 3WA 製作的 Mio 米歐，VRM 1.0；使用條件以模型內嵌 metadata 為準，https://3wa.tw 。`licenses/model-meta.json` 為先前 pixiv 範例模型的歷史資料，不代表 Mio 授權。
- Three.js 0.180.0、three-vrm 3.5.5：MIT，附原始授權。
- edge-tts 7.2.8：LGPLv3，附原始授權，來源 https://github.com/rany2/edge-tts 。本程式透過套件使用，未修改其套件原始碼。
- 本原型自有程式碼：MIT，詳見 `LICENSE`。

若使用受信任的公司 TLS 代理，可將 `AVATAR_TTS_CA_BUNDLE` 設為該 CA 的 PEM 檔案路徑；程式保留憑證驗證。一般家用環境不需設定。
