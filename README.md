# foodpanda-mcp-tw（foodpanda 台灣版 MCP server）

讓 AI 助理（Claude Code、Codex CLI、Claude Desktop 等 MCP client）幫你在 **foodpanda 台灣**
（www.foodpanda.com.tw）搜尋餐廳、看菜單、組購物車，並在你確認後下單。

> **這是非官方工具。** 它呼叫的是 foodpanda 網站自己用的內部 API，不是公開 API，
> foodpanda 隨時可能改版讓它失效，使用上也可能違反 foodpanda 的服務條款。
> 請只用在自己的帳號上，風險自負。詳見[已知限制](#已知限制)。

## 目錄

- [來源](#來源)
- [開發狀態](#開發狀態)
- [需求](#需求)
- [安裝與建置](#安裝與建置)
- [設定 MCP client](#設定-mcp-client)（Claude Code、Codex CLI、Claude Desktop）
- [環境變數](#環境變數)
- [登入與 token](#登入與-token)
- [付款方式](#付款方式)
- [下單安全：兩步下單](#下單安全兩步下單)
- [可用的 tools](#可用的-tools)
- [GraphQL hash 失效時](#graphql-hash-失效時)
- [PerimeterX 防機器人機制](#perimeterx-防機器人機制)
- [已知限制](#已知限制)
- [開發](#開發)
- [授權與致謝](#授權與致謝)

## 來源

本專案 fork 自 [vienneje/foodpanda-mcp-hk](https://github.com/vienneje/foodpanda-mcp-hk)（香港版），
而它又 fork 自 [johnwhoyou/foodpanda-mcp](https://github.com/johnwhoyou/foodpanda-mcp)（菲律賓版）。

和香港版相比，這個版本：

- 新增 `tw` region preset 並設為預設（`https://tw.fd-api.com`、`https://www.foodpanda.com.tw`、
  `zh_TW`、`TWD`、language id `6`、`x-global-entity-id: FP_TW`）。所有值都取自實際在台灣站錄下的網路流量，沒有猜測。
- 搜尋、連鎖分店、餐廳資訊、菜單、品項選項、購物車驗價改用台灣網站實際使用的 GraphQL 查詢與資料格式。
- 付款只支援「已綁定的 LINE Pay」與「貨到付款（現金）」，其他方式一律明確報錯（見[付款方式](#付款方式)）。
- 下單改為兩步，需要一次性確認碼（見[下單安全](#下單安全兩步下單)）。
- 儲存的 token 會檢查區域和是否過期；登入過期後會自動改用 `token.json` 裡同一個帳號較新的登入，不用重啟。

`hk`、`ph` preset 仍然保留、可以載入，但瀏覽與購物車現在是照台灣網站的做法寫的，**不保證**能用在香港或菲律賓。

## 開發狀態

| 階段 | 內容 | 狀態 |
|---|---|---|
| 1 | 架構報告 | 完成 |
| 2 | `tw` preset、登入、token 檢查 | 完成 |
| 3 | 搜尋、菜單、品項選項、購物車驗價 | 完成，2026-10-13 在真實網站上實測通過 |
| 4 | 付款（LINE Pay／現金）與兩步下單 | 完成；現金與 LINE Pay 都實測到 `prepare_order` 為止。**還沒有真的下過單**，結帳成功的格式未知 |
| 5 | 測試與 README | 完成 |

要把它接到其他服務（例如 mcp-check、Grok Bot）的人，請先看 [docs/handoff.md](docs/handoff.md)。


## 需求

- Node.js（本 repo 沒有指定最低版本）
- Playwright 的 Chromium（`npx playwright install chromium`）。API 請求和登入都在真的瀏覽器裡進行。
- **Linux 伺服器沒有 `DISPLAY`（沒有螢幕）時，必須先安裝 Xvfb**（`apt-get install xvfb`）。瀏覽器必須以有畫面（headed）模式執行才過得了 PerimeterX，
  程式會自己啟動一個 Xvfb 虛擬螢幕；沒裝的話會回錯誤「Xvfb is not installed」。
  Mac、Windows 和有桌面的 Linux 會直接開一般的瀏覽器視窗，不需要 Xvfb。
- 一個 foodpanda 台灣帳號，而且**要用的外送地址已經先存在帳號裡**。下單時在 `prepare_order` 選定地址（見[下單安全](#下單安全兩步下單)）。

## 安裝與建置

```bash
git clone https://github.com/TobyWu666/foodpanda-mcp-tw.git
cd foodpanda-mcp-tw
npm install
npm run build                    # 產生 build/
npx playwright install chromium  # 完整版 Chromium（new headless 模式）
```

以下設定範例中的 `/絕對路徑/foodpanda-mcp-tw/build/index.js` 請換成你電腦上的實際路徑。

先確認設定解析正確（不需要啟動 client，也不會連線）：

```bash
FOODPANDA_LATITUDE=25.0330 FOODPANDA_LONGITUDE=121.5654 \
  node -e "import('./build/config.js').then(m => console.log(m.getRegionConfig()))"
```

## 設定 MCP client

所有範例的座標 `25.0330, 121.5654` 都只是**示意值**（台北 101 一帶），請換成你自己外送地址的座標。
MCP server 不會繼承你 shell 的環境變數，所有設定都要寫在 client 設定的 `env` 裡。

> **隱私提醒：** client 設定檔裡會有你的座標（以及你自己貼進去的 token），不要把它 commit 進 git。
> 本 repo 的 `.gitignore` 已排除 `.mcp.json` 和 `claude_desktop_config.json`。
> 建議用 token 檔登入（見[登入與 token](#登入與-token)），不要把 token 寫進設定檔。

### Claude Code

用指令加入（`--scope user` 會存在你的使用者設定，不會出現在任何專案資料夾裡）：

```bash
claude mcp add foodpanda --scope user \
  -e FOODPANDA_LATITUDE=25.0330 \
  -e FOODPANDA_LONGITUDE=121.5654 \
  -- node /絕對路徑/foodpanda-mcp-tw/build/index.js
```

建議只用使用者層級的設定（上面的 `--scope user`）。**不要**把這些設定寫進專案資料夾的 `.mcp.json`，裡面的座標（和 token，如果有設）可能會被 commit 進 git。

tools 會以 `mcp__foodpanda__<tool 名稱>` 出現。
**不要**把 `mcp__foodpanda__place_order` 加進 `settings.json` 的 `permissions.allow`，
也不要在 Claude Code 詢問時選「不再詢問」。見[下單安全](#下單安全兩步下單)。

### Codex CLI

在 `~/.codex/config.toml` 加入：

```toml
[mcp_servers.foodpanda]
command = "node"
args = ["/絕對路徑/foodpanda-mcp-tw/build/index.js"]

[mcp_servers.foodpanda.env]
FOODPANDA_LATITUDE = "25.0330"
FOODPANDA_LONGITUDE = "121.5654"
```

**不要**把 Codex 設成會自動核准 MCP tool 呼叫的模式來使用這個 server；`place_order` 每次都必須由你親自核准。

### Claude Desktop

編輯 `claude_desktop_config.json`（Claude Desktop：設定 → 開發者 → 編輯設定）：

```json
{
  "mcpServers": {
    "foodpanda": {
      "command": "node",
      "args": ["/絕對路徑/foodpanda-mcp-tw/build/index.js"],
      "env": {
        "FOODPANDA_LATITUDE": "25.0330",
        "FOODPANDA_LONGITUDE": "121.5654"
      }
    }
  }
}
```

存檔後完全結束並重新開啟 Claude Desktop。
Claude Desktop 詢問是否允許 tool 時，`place_order` **不要**選「一律允許」，每次都按「允許一次」。

### 啟動訊息

server 啟動時會在 stderr 印一行它解析到的區域，可以用來確認設定：

```
foodpanda-mcp: region=foodpanda Taiwan api=https://tw.fd-api.com web=https://www.foodpanda.com.tw ...
```

## 環境變數

### 必填

| 變數 | 說明 |
|---|---|
| `FOODPANDA_LATITUDE` / `FOODPANDA_LONGITUDE` | 外送地址座標（例如 `25.0330` / `121.5654`，僅示意）。沒設定 server 不會啟動。 |

### 區域（預設就是台灣，通常不用改）

| 變數 | 預設（tw） | 說明 |
|---|---|---|
| `FOODPANDA_COUNTRY` | `tw` | preset：`tw`、`hk`、`ph` |
| `FOODPANDA_API_BASE` | `https://tw.fd-api.com` | API host |
| `FOODPANDA_WEB_HOST` | `https://www.foodpanda.com.tw` | 網站，用於登入與付款導回 |
| `FOODPANDA_LOCALE` | `zh_TW` | API locale |
| `FOODPANDA_LANGUAGE_ID` | `6` | 送在 `x-pd-language-id` 與 GraphQL 變數 |
| `FOODPANDA_CURRENCY` | `TWD` | 購物車幣別 |
| `FOODPANDA_GLOBAL_ENTITY_ID` | `FP_TW` | `x-global-entity-id` header |

### GraphQL 查詢 hash（已內建台灣版，網站改版失效時才需要覆寫）

| 變數 | 用於 |
|---|---|
| `FOODPANDA_GQL_SEARCH_HASH` | `search_restaurants`（`SearchResults`） |
| `FOODPANDA_GQL_VENDOR_LIST_HASH` | `list_outlets`（`GetVendorListPage`） |
| `FOODPANDA_GQL_RESTAURANT_DETAILS_HASH` | `get_restaurant_details`、`get_menu`（`GetRestaurantDetailsPage`） |
| `FOODPANDA_GQL_PRODUCT_HASH` | `get_item_details`、`add_to_cart` 的選項（`RestaurantProductQuery`） |

### 登入與資料位置

| 變數 | 預設 | 說明 |
|---|---|---|
| `FOODPANDA_HEADLESS` | `0`（關） | 設為 `1` 時瀏覽器不顯示視窗。**不建議開啟**：foodpanda 的防機器人機制（PerimeterX）會擋 headless 瀏覽器，搜尋時就會回「Access denied」；`refresh_token` 登入也需要看得到的視窗，開啟時會直接回錯誤。 |
| `FOODPANDA_STATE_DIR` | `~/.foodpanda-mcp` | 放 `token.json`、瀏覽器設定檔 `browser-data/`，以及下單狀態不明時的鎖定檔 `order-check-required.json` |
| `FOODPANDA_SESSION_TOKEN` | 未設定 | 自行提供 token（不建議，見下方）。過期的會被忽略。 |

### 瀏覽器與網路（進階）

| 變數 | 預設 | 說明 |
|---|---|---|
| `FOODPANDA_BROWSER_TRANSPORT` | `1` | API 請求透過瀏覽器送出（帶 PerimeterX cookie） |
| `FOODPANDA_BROWSER_CHANNEL` | `chromium` | 要驅動的 Chromium 版本；設為空字串則用 Playwright 預設（headless shell） |
| `FOODPANDA_BROWSER_EXECUTABLE` | 未設定 | 指定瀏覽器執行檔的絕對路徑（系統的 Chrome／Chromium） |
| `FOODPANDA_PROXY` | 未設定 | 瀏覽器走的 proxy：`socks5://host:port`、`http://host:port`、`http://user:pass@host:port` |
| `FOODPANDA_XVFB` | `1` | 需要有畫面的瀏覽器但沒有 `DISPLAY` 時，自動啟動 Xvfb |
| `FOODPANDA_FETCH_MODE` | `auto` | `page` 或 `context`，強制從網頁或瀏覽器 context 發請求 |
| `FOODPANDA_MIN_INTERVAL_MS` | `2000` | 兩次 API 請求之間的最短間隔（毫秒） |
| `FOODPANDA_PX_BACKOFF_MS` | `45000` | 被 PerimeterX 擋時第一次退避等待（毫秒），之後加倍 |

要支援其他國家：在 `src/config.ts` 的 `PRESETS` 加一組，或直接設定 `FOODPANDA_API_BASE`、
`FOODPANDA_WEB_HOST`、`FOODPANDA_LOCALE`、`FOODPANDA_CURRENCY` 等變數。

## 登入與 token

不需要從瀏覽器開發者工具複製 token。流程是：

1. 確認 client 設定裡沒有 `FOODPANDA_HEADLESS=1`（預設就是關閉，不用另外設定）。
2. 請 AI 呼叫 **`refresh_token`**。server 會打開一個看得到的瀏覽器視窗，開啟 www.foodpanda.com.tw。
3. 你**自己**在視窗裡登入（含 CAPTCHA、簡訊或 e-mail 驗證碼）。預設等 120 秒，可以請 AI 帶 `timeout` 參數延長。
4. 網頁送出的 Bearer token 會被自動擷取，存到 `$FOODPANDA_STATE_DIR/token.json`（權限 0600），
   並記錄這個 token 是哪個 API host（區域）的。

之後啟動時：

- 讀取 token 的順序是：`token.json` → `FOODPANDA_SESSION_TOKEN` → 沒有 token。
- `token.json` 只有在**區域相同**（例如都是 `https://tw.fd-api.com`）而且**沒過期**時才會使用。
  香港版存下的 token 不會被拿來打台灣的 API；沒記錄區域的舊 token 檔也不會用。
- 過期的 token 會被忽略並在 stderr 說明原因。台灣的登入沒有標準的 `exp`，而是用 `expires`（秒），**大約 1 小時就過期**。
- 瀏覽器設定檔 `browser-data/` 會保留登入狀態與 PerimeterX 的通行 cookie。
- `refresh_token` 只會接受**已登入帳號**的 token：擷取到的每個 token 都會先查一次 `/api/v5/customers`，
  查不到帳號（例如訪客 token）就略過，繼續等你登入。

執行中登入過期時：

- 送出請求前發現 token 已過期，或 foodpanda 回 401/403 時，server 會重新讀 `token.json`
  （只有檔案有變動時才讀）。如果裡面是**同一個帳號**、還沒過期、而且比現在的晚過期的登入，就改用它，並把那個請求重試**一次**。
- 只接受同一個帳號（JWT 的 `user_id` 相同）。要換帳號只能用 `refresh_token`。
- `place_order` 進行中如果換了登入，結帳**不會送出**，會回「login changed … nothing was sent」，請重新 `prepare_order`。
- 結帳本身永遠不重試。stderr 只會寫一行固定文字，不會印出 token。

沒有登入也可以**搜尋和看菜單**（這些是公開資料）；購物車與下單需要登入。（這是香港版的經驗，台灣站尚未驗證。）

> 不建議用 `FOODPANDA_SESSION_TOKEN`：token 會因此寫在 client 設定檔裡，容易被備份、分享或誤 commit。

### 在沒有螢幕的伺服器上

登入一定要有看得到的瀏覽器視窗。建議在有螢幕的電腦上登入，再把 `token.json` 和 `browser-data/`
整個複製到伺服器的 `FOODPANDA_STATE_DIR`。香港版的 `scripts/login-browser.sh` 已移除
（它寫死香港網址，而且會開本機遠端除錯埠）。

### 二階段驗證（2FA）

- 登入若要求簡訊或 e-mail 驗證碼，你可以在 `refresh_token` 打開的視窗裡直接手動輸入。
- **不要**讓 AI 代你輸入密碼或驗證碼。
- 香港版的經驗：用自動化工具（密碼管理器自動填入等）填 foodpanda 的驗證碼欄位會失敗，因為它是四個分開的單字元輸入框。
- 台灣站的登入已在 2026-10-13 實測過：存下的是帳號 token（不是訪客 token）。

## 付款方式

只支援兩種：

| 名稱 | 說明 | foodpanda 內部識別（取自抓包） |
|---|---|---|
| `linepay` | 帳號裡**已綁定**的 LINE Pay（自動扣款） | `line_pay`（已存的付款工具） |
| `cash` | 貨到付款（現金） | `payment_on_delivery` |

- 信用卡、全支付及其他付款方式**不支援**。
- 指定不支援或帳號上不可用的方式時，會回傳明確錯誤（錯誤代碼 `UNSUPPORTED_PAYMENT_METHOD`，
  訊息會列出可用的方式並註明「沒有改用其他付款方式」），**絕不會**默默換成別的方式。
- **只能用已綁定的 LINE Pay。** 帳號沒有綁定 LINE Pay 時，`linepay` 會被拒絕（錯誤：`LINE Pay not bound`），
  不會改走需要 LINE app 的流程，也不會改用現金。
- `list_payment_methods`（不需參數，購物車不能是空的）會列出：
  - `available`：這次訂單可用的 `linepay`／`cash`
  - `unavailable`：不可用的那幾個，附原因
  - `not_supported_by_this_server`：foodpanda 有提供、但這個 server 不支援的其他方式（只列出，永遠不會使用）
- 付款方式在 `prepare_order` 的 `payment_method` 選定（`linepay` 或 `cash`），之後不能在 `place_order` 更改。

> **LINE Pay 尚未驗證：** 目前還不知道已綁定的 LINE Pay 結帳時是直接扣款，還是會要求跳轉到 LINE 確認。
> 這要等第一次真實下單才能確認（只會由帳號擁有者手動進行）。
> 結帳回應只要不是明確成功（包括要求跳轉或額外付款步驟），server 都會回報「訂單狀態不明，請先到 foodpanda app 或網站確認」，
> **不會**重試，也**不會**改用現金。

## 下單安全：兩步下單

下單拆成兩步（舊版的一步下單 `preview_order` 已移除）：

1. **`prepare_order`**：用選定的地址和付款方式為目前的購物車驗價並鎖定，**不會下單**。參數：
   - `payment_method`（必填）：`linepay` 或 `cash`
   - `address_id`（選填，整數）：帳號只有一個已存地址時自動使用；有好幾個時必填，沒填的話錯誤訊息會列出所有地址讓你選
   - `delivery_instructions`（選填，最多 300 字）：給外送員的備註
   - `previous_order_checked_in_app`（選填，true/false）：只在上一次 `place_order` 回報「狀態不明」之後使用，見下方

   回傳完整訂單內容：品項、數量、選項、小計、外送費、服務費、總金額、付款方式、外送地址，以及一組**一次性確認碼**
   `confirmation_code`（5 分鐘內有效）。小計低於餐廳最低消費時，會多一個 `small_order_fee`（小額訂單費）和說明；
   如果還有總金額解釋不了的部分，會列在 `other_charges`。`get_cart`／`add_to_cart` 也會顯示這兩個欄位。
2. **`place_order`**：**只收** `confirmation_code`，才會真的送出訂單（會扣款）。付款方式、地址、備註都已綁在確認碼裡，不能在這一步更改。
   失敗時，錯誤訊息最後一行一定是下面其中一種，讓 AI 或審核工具分得清楚：
   - `[checkout_sent: no] ...`：還沒送出，沒有下單。
   - `[checkout_sent: unknown] ...`：可能已經下單，要先到 foodpanda app 查。

確認碼的規則：

- 5 分鐘後失效。
- 只能用一次；送單**之前**就先作廢，所以就算送單失敗也不能用同一組碼重試，要重新 `prepare_order`。
- 購物車、價格、付款方式、地址任何一項改變，確認碼就失效；再呼叫一次 `prepare_order` 也會讓前一組碼失效。
- server 重新啟動後，所有確認碼都失效。
- 結帳**絕不重試**。回應只要不是明確成功（例如連線中斷、LINE Pay 要求跳轉），server 都會回報「狀態不明，請先到 foodpanda app 確認」，不要再呼叫 `place_order`。
- **結果不明後的鎖定：** 一旦 `place_order` 回報「狀態不明」，購物車會被清空，`prepare_order` 也會拒絕執行，
  直到它帶著 `previous_order_checked_in_app: true` 被呼叫。AI **只有在你確認過 foodpanda app、而且仍然要再下一單**時才可以設這個值，
  不能自己設。這個鎖存在 `$FOODPANDA_STATE_DIR/order-check-required.json`（權限 0600，只記錄時間和固定的原因，沒有訂單內容或個資），
  所以 server 或 client 重新啟動後鎖**仍然有效**。帶 `previous_order_checked_in_app: true` 呼叫 `prepare_order` 會刪除這個檔案、解除鎖定。
  （如果這個檔案寫不進去，鎖仍會在記憶體中生效，但 server 重啟後就會解除；stderr 會留下一行提示。）
- **成功的判定很嚴格：** 目前還沒有錄到台灣站真正成功的結帳回應，所以只有回應裡同時有訂單編號、明確的成功狀態、
  而且沒有任何待處理步驟（跳轉、連結、pending 狀態等）時才算成功，其他一律回報「狀態不明」。
  因此**第一筆真實訂單即使成功了，也很可能顯示「狀態不明」**。這是刻意偏向安全的設計，請到 app 確認即可；
  等錄到台灣站真正的成功回應後會再調整。
- **金額或付款方式不符：** 如果 foodpanda 結帳回應的總金額或付款方式和 `prepare_order` 鎖定的不同，結果會多一個以 `MISMATCH:` 開頭的
  `attention` 欄位，AI 必須立刻告訴你，請到 app 檢查這筆訂單。

tool 說明裡已明確寫：AI 必須先把 `prepare_order` 的內容完整給你看，取得你明確同意後，才能呼叫 `place_order`。

### 最重要的一條

> **Never add place_order to your client's auto-approve / always-allow list.** The confirmation
> code stops stale or changed orders, but the agent can read the code, and after an order with an
> unknown outcome the agent can also lift the check-the-app lock itself
> (previous_order_checked_in_app). Only your client's per-call approval prompt guarantees a human
> said yes.

**絕對不要把 `place_order` 加進任何 client 的自動核准／一律允許清單。** 確認碼能擋下過期或內容被改過的訂單，
但 AI 自己讀得到確認碼；訂單狀態不明之後，AI 也能自己帶 `previous_order_checked_in_app` 解除「先確認 app」的鎖。
所以這些機制都**無法證明是你本人同意的**。真正保證「有人說好」的，只有 client
每次呼叫 `place_order` 前跳出來問你的那個確認視窗。

- Claude Code：不要放進 `permissions.allow`，詢問時不要選「不再詢問」。
- Codex CLI：不要用會自動核准 MCP tool 呼叫的設定。
- Claude Desktop：不要選「一律允許」。

開發與測試期間，所有測試只做到購物車驗價為止，不會送出真實訂單。

## 可用的 tools

| Tool | 說明 |
|---|---|
| `search_restaurants` | 依名稱或料理類型搜尋你座標附近的餐廳 |
| `list_outlets` | 連鎖品牌的所有分店 |
| `get_restaurant_details` | 營業時間、外送費、最低消費、地址 |
| `get_menu` | 依分類列出完整菜單；有選項的品項會標 `has_options` |
| `get_item_details` | 一個品項的選項群組（例如套餐飲料、加購）；可選填 `variation_id` |
| `add_to_cart` | 加入購物車，`topping_ids` 填選項代碼；必選群組沒選、選太多、選了不存在或售完的選項都會擋下 |
| `get_cart` / `remove_from_cart` | 查看／移除購物車品項，價格會向 API 重新驗算 |
| `refresh_token` | 開瀏覽器讓你登入，擷取並儲存 token |
| `list_payment_methods` | 列出這次訂單可用／不可用的付款方式（只會用 `linepay`、`cash`），購物車不能是空的 |
| `prepare_order` | 下單第 1 步：選付款方式、地址、備註，驗價並產生 5 分鐘有效的確認碼，不會下單 |
| `place_order` | 下單第 2 步：只收 `confirmation_code`，送出真實訂單。**絕不能設成自動允許** |

## GraphQL hash 失效時

搜尋、分店、餐廳資訊、品項選項用的是 Apollo **persisted query**：請求裡送的不是查詢內容，而是一段 sha256 hash，
這個 hash 是編譯在 foodpanda 網站程式裡的。台灣版的 4 個 hash 已內建（2026-10-12 取得），
但 foodpanda 網站改版後可能失效，此時錯誤訊息會指出是哪一個。重新取得：

```bash
node scripts/discover-hashes.mjs
# 搜尋關鍵字預設是「麥當勞」，可以用 FOODPANDA_DISCOVER_QUERY 改
```

腳本會打開網站並自動搜尋一次。等待的 60 秒內，請在視窗裡**手動**點開一個連鎖品牌的分店列表、一家餐廳、
一個有選項的品項，讓對應的查詢都發出去。最後會印出：

```
FOODPANDA_GQL_SEARCH_HASH=...
FOODPANDA_GQL_VENDOR_LIST_HASH=...
FOODPANDA_GQL_RESTAURANT_DETAILS_HASH=...
FOODPANDA_GQL_PRODUCT_HASH=...
```

把它們加到 client 設定的 `env` 裡即可。

## PerimeterX 防機器人機制

> 本節大多是香港版實測的經驗。台灣站已確認的一點：headless 瀏覽器在搜尋時就會被回「Access denied」，
> 所以 `FOODPANDA_HEADLESS` 預設是關閉的。

`*.fd-api.com` 前面有 PerimeterX。能不能通過，看的不是你在哪個國家，而是瀏覽器像不像自動化程式：

- 單純的 `fetch()`、curl、**headless** 瀏覽器會被擋（`403` 加 `px-captcha`，或「Access to this page has been denied」頁面）。
- 同一台機器、同一個 IP，改用**有畫面**的 Chromium（伺服器上用 Xvfb 虛擬螢幕）就能通過。

因此：

- 被擋時，程式先只清掉 PerimeterX 自己的 cookie（`_px` 開頭）再試，**登入狀態會保留**；
  還是被擋，最後才整個重置瀏覽器設定檔（這會登出），最多試 3 次。實測時每次啟動瀏覽器都會先被擋一次，這是正常的。
- 連續太多請求也會被擋：請求之間至少間隔 `FOODPANDA_MIN_INTERVAL_MS`（預設 2 秒），
  被擋時退避 45 秒、再 90 秒，然後清掉 PerimeterX cookie 重試。這些重試只用在瀏覽與購物車；**結帳（`place_order`）絕不重試**。
- token 救不了被擋的瀏覽器；如果一直被擋（例如雲端機房 IP），用 `FOODPANDA_PROXY` 換一個出口。

## 已知限制

1. **非官方 API，隨時可能失效。** 呼叫的是 foodpanda 網站內部 API，foodpanda 改版時端點、欄位、
   GraphQL hash 都可能改變而讓功能壞掉，也可能違反服務條款。請自負風險、只用自己的帳號。
2. **只實測到 `prepare_order`。** 2026-10-13 在真實網站上，登入、搜尋、菜單、購物車驗價、付款方式、
   `prepare_order`（現金與 LINE Pay）都通過了。單元測試使用遮蔽過個資的資料。
3. **登入與二階段驗證。** 登入一定要有看得到的視窗並由你親自完成；不能由 AI 代填驗證碼。
   登入大約 1 小時過期，要重新登入（server 會自動改用 `token.json` 裡較新的同帳號登入）。
4. **結帳尚未在台灣站實測。** 送出的格式照抓包組成，但 `cart/checkout` 從沒在台灣站真的送過（開發時刻意不下單）。
   第一次真實下單只會由帳號擁有者手動進行。在錄到台灣站真正的成功回應之前，第一筆訂單即使成功也很可能顯示「狀態不明」，
   之後要先到 app 確認，再帶 `previous_order_checked_in_app: true` 才能下下一單。
5. **已綁定 LINE Pay 是否直接扣款、不跳轉，目前未知。** 結帳回應只要不是明確成功（包括要求跳轉），結果都會是「狀態不明，請到 app 確認」，
   **不會**改用現金，也不會重試。
6. **結帳絕不重試。** 任何錯誤或不明結果都要先到 foodpanda app 確認訂單，再決定要不要重新 `prepare_order`。
7. **付款只支援已綁定的 LINE Pay 與現金。** 未綁定的 LINE Pay、信用卡等其他方式都會被明確拒絕。
8. **外送地址必須先存在帳號裡。** 有多個已存地址時要在 `prepare_order` 指定 `address_id`。
9. **實際扣款金額可能和 `prepare_order` 顯示的不同。** 外送費與總金額是用已存地址的座標計算的，
   沒有帶入完整的已存地址資料，foodpanda 結帳時算出的金額可能有差。實測時外送費在幾分鐘內就在 15 和 19 元之間變動過。
   **建議第一筆真實訂單用小額、現金付款**，並比對 `prepare_order` 的總金額和 foodpanda app 上的實際金額。
   結帳回應若報出不同的總金額或付款方式，結果會帶 `MISMATCH` 提醒。
10. **PerimeterX。** 見上一節；headless 會被擋，雲端 IP 可能需要 proxy。
11. **只在台灣驗證。** `hk`、`ph` preset 可以載入，但瀏覽與購物車照台灣網站的格式寫，不保證可用。

## 開發

```
src/config.ts               區域 preset 與 env 解析
src/browser-transport.ts    當作 HTTP transport 的 Playwright 持久瀏覽器
src/foodpanda-client.ts     API client（搜尋、菜單、購物車、結帳）
src/tw-api.ts               台灣站的請求格式與回應解析（含付款與結帳）
src/payment-method.ts       支援的付款方式（linepay、cash）與明確錯誤
src/order-guard.ts          兩步下單確認碼
src/order-lock.ts           「狀態不明」後的鎖定檔
src/place-order-failure.ts  place_order 錯誤的 [checkout_sent: ...] 結尾
src/token-manager.ts        token 儲存、瀏覽器登入、重新讀取 token.json
src/token-check.ts          token 區域與過期檢查（exp 或 expires）
src/redact.ts               錯誤訊息與 log 的個資遮蔽
src/server.ts               MCP tool 定義
src/index.ts                stdio 進入點
scripts/discover-hashes.mjs GraphQL persisted-query hash 擷取
scripts/mask-capture.mjs    抓包資料個資遮蔽（產生 test fixture 用）
docs/handoff.md             給接手串接的人：驗證過什麼、還沒驗證什麼
docs/mcp-check.md           搭配 mcp-check 使用
```

```bash
npm install
npm run build
npm test                                   # TypeScript 單元測試
npx tsc && node --test test/privacy.test.mjs   # 隱私遮蔽測試
```

`build/` 不進 git，clone 後要自己建置。

### 抓包資料與隱私

- 原始抓包（`captures/`、`*.har` 等）、token、cookie、`.env`、client 設定檔都已列在 `.gitignore`，**不能進 git**。
- 要做成測試 fixture 時，先用 `scripts/mask-capture.mjs` 遮蔽個資，再用它的 `--check` 檢查，
  並且**人工逐一看過**（腳本抓不到所有情況，例如未知欄位裡的姓名）。只有 `test/fixtures/*.masked.json` 可以 commit。
- 開發與測試都不能送出真實訂單；只測到購物車驗價。

## 授權與致謝

MIT。原始專案與實作：[johnwhoyou/foodpanda-mcp](https://github.com/johnwhoyou/foodpanda-mcp)（© John Carlo Joyo）；
香港版：[vienneje/foodpanda-mcp-hk](https://github.com/vienneje/foodpanda-mcp-hk)。
