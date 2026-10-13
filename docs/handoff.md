# 交接說明：把 foodpanda-mcp-tw 接到其他服務

給接手把這個伺服器接到 mcp-check、Grok Bot 或其他服務的人。寫於 2026-10-13。

## 現在的狀態

- `main` 可以建置，`npm test` 全部通過，隱私測試（`test/privacy.test.mjs`）也通過。
- 對外只有 stdio MCP（`build/index.js`）。工具清單和規則見 [README](../README.md)。
- 付款只用**已綁定的 LINE Pay** 和**貨到付款（現金）**，下單一定是兩步：`prepare_order` → `place_order`。

## 在真實網站上驗證過的

2026-10-13 在帳號擁有者的 Mac 上跑了兩次，都停在 `prepare_order`，**沒有下單**：

- 登入（`refresh_token`），存下的是帳號 token，不是訪客 token。
- 搜尋、餐廳資訊、菜單、加入購物車與驗價。
- `list_payment_methods`：綁定的 LINE Pay 和現金都可用，信用卡列為不支援。
- `prepare_order`：**現金和 LINE Pay 都成功**，金額和地址正確。小計低於最低消費時，`small_order_fee` 也正確顯示。

## 還沒驗證的

- **結帳（`place_order`）從來沒有真的送過。** foodpanda 收不收我們組的 `cart/checkout`、成功時回什麼格式，都不知道。
  - 判斷規則在 `src/tw-api.ts` 的 `parseCheckoutResponse`：回應裡**同時**有訂單編號、明確的成功狀態，
    而且沒有任何待處理的跡象（跳轉、連結、pending 狀態等），才算成功。其他情況一律當成「狀態不明」：
    回 `[checkout_sent: unknown]`、清空購物車，並在 `FOODPANDA_STATE_DIR/order-check-required.json` 鎖住下一筆訂單。
    要有人到 foodpanda app 確認過，帶 `previous_order_checked_in_app: true` 呼叫 `prepare_order`，鎖才會解除。
  - 因為還不知道台灣站成功時回什麼，**第一筆真實訂單即使成功，也很可能顯示「狀態不明」**。
  - 第一筆真實訂單要由帳號擁有者手動下，**小額、現金**，同時錄下結帳的請求和回應（遮蔽個資後）。
    之後才能寫出台灣站真正的成功判斷。
- **綁定的 LINE Pay 結帳時會不會跳轉。** 如果要跳轉，結果一樣是「狀態不明」，不會改用現金。
- **登入怎麼續期。** 登入大約 1 小時過期。伺服器會自動改用 `token.json` 裡同一個帳號較新的登入（不用重啟），
  但需要有東西去更新這個檔案：
  - 抓包裡沒有 token 續期的請求。
  - 也還沒確認過：瀏覽器設定檔保留登入後，`refresh_token` 能不能不用重新輸入就拿到新的登入。
  - 在 mcp-check 後面，`refresh_token` 不對外開放。同一個瀏覽器設定檔（`browser-data/`）**很可能**不能同時被兩個程序開啟
    （這是推測，還沒實測）。所以目前最保險的做法是停掉 mcp-check、用一般 MCP client 登入，再啟動 mcp-check。

## 接上 mcp-check 之前一定要處理的

設定方式見 [mcp-check.md](mcp-check.md)。審核時在 mcp-check 發現兩個問題，**在開放任何公開網址之前要先修好**。
這兩個都在 mcp-check 那邊，這個 repo 沒有改：

1. **登入的次數限制看的是 `X-Forwarded-For` 的第一個值，而這個值是連線的人自己填的。**
   - `TRUST_PROXY=1` 時：任何人換一個值就能重來，可以**無限次猜手機 App 的登入密碼**。
   - `TRUST_PROXY=0` 時：任何人猜錯 5 次，就能讓擁有者 **15 分鐘不能登入**。
   - 修好之前，在通道後面請用 `TRUST_PROXY=0`。代價是別人可以把擁有者暫時鎖在外面，但密碼不會被無限次猜。
2. **手機 App 可以把 `submit_order` 設成 allow。** 設了之後，每一筆訂單都會自動核准，**沒有人確認就下單**。
   修好之前，**絕對不要**把 `submit_order` 改成 allow。

在這兩個修好、而且帳號擁有者決定要下第一筆真訂單之前，`FOODPANDA_TW_REAL_ORDERS` 保持 `0`（不設也一樣是關閉），
這樣 `submit_order` 不會真的下單。

## 另一個做法：PR #12（沒有合併）

PR #12 做了 HTTP 版本，下單前在 Mac 跳確認視窗或用 Telegram 確認。它**沒有合併**，是 mcp-check 以外的另一個選擇。
兩個不要同時接，不然同一筆單要核准兩次。

## 不能改的安全規則

- `place_order` 不能被任何人或程式自動核准。確認碼 AI 讀得到，「先確認 app」的鎖 AI 也能自己解，
  所以每一筆都要有真人按確認。
- 結帳絕不重試。錯誤訊息最後一行是 `[checkout_sent: no]`（沒送出）或 `[checkout_sent: unknown]`（可能已下單），
  看到 `unknown` 一定要先到 foodpanda app 查。
- 登入過期時，只會改用**同一個帳號**的新登入。`place_order` 進行中換了登入，就不送出結帳。
- token、cookie、地址、座標、抓包檔都不能進 git。`test/fixtures/` 只放遮蔽過的資料。

## 串接時會依賴的格式

`test/hub-contract.test.ts` 固定了 `prepare_order`、`place_order` 回傳的格式。改動前先看這個測試，改了要一起更新。
`prepare_order` 另外可能多出 `small_order_fee`、`small_order_fee_note`、`other_charges`、`other_charges_note`，
這些欄位只在有值時才會出現。
