# 搭配 mcp-check（手機審核中心）使用

[mcp-check](https://github.com/TobyWu666/mcp-check) 是放在 AI 和 MCP server 中間的審核中心。
AI（例如 Grok Bot）連到 mcp-check，不直接連 foodpanda-mcp-tw；mcp-check 在背景用 stdio
啟動這個伺服器來用。

- 查餐廳、看菜單、加減購物車：mcp-check 直接轉給這個伺服器。
- 下單：AI 看不到 `prepare_order` / `place_order` / `refresh_token`，只能呼叫 mcp-check 的
  `foodpanda_tw__submit_order`。mcp-check 先呼叫 `prepare_order`，把品項、金額、地址、付款方式
  送到你的手機；你按「核准」後，它**再呼叫一次** `prepare_order`，內容完全一樣才用新的確認碼呼叫
  `place_order`，有任何不同就不下單。
- 確認碼只在 mcp-check 和這個伺服器之間傳，AI 拿不到，所以 AI 不能自己跳過審核。

## 在 Mac 上設定

foodpanda 的登入和 Chrome 視窗都在你的 Mac 上，所以 mcp-check 也跑在同一台 Mac 最簡單。

1. 在這個專案執行 `npm run build`，得到 `build/index.js`。
2. 先用平常的方式登入一次 foodpanda（`refresh_token`），登入會存在 `~/.foodpanda-mcp/`。
3. 啟動 mcp-check 時加上這些環境變數（`FOODPANDA_` 開頭、但不是 `FOODPANDA_TW_` 開頭的變數，
   mcp-check 會原樣傳給這個伺服器）：

   | 變數 | 值 |
   | --- | --- |
   | `FOODPANDA_TW_ENABLED` | `1` |
   | `FOODPANDA_TW_ENTRY` | 這個專案 `build/index.js` 的完整路徑 |
   | `FOODPANDA_LATITUDE`、`FOODPANDA_LONGITUDE` | 外送地址的座標 |
   | `FOODPANDA_BROWSER_CHANNEL` | `chrome`（和平常一樣） |
   | `FOODPANDA_TW_REAL_ORDERS` | 先不要設。設成 `1` 才會真的下單 |

4. 在 mcp-check 建一個 Agent：`npm run admin -- create-agent grok "foodpanda_tw__*"`，
   把拿到的 `mcpa_...` token 填到 Grok Bot 的 `Authorization: Bearer ...` header。
   Grok Bot 在雲端，所以 mcp-check 需要一個公開的 HTTPS 網址（例如通道），並把那個網址設成
   `PUBLIC_BASE_URL`。

## 注意

- **只選一道審核**：PR #12 另外做了一個 HTTP 版本（`foodpanda-mcp-http`，Mac 對話框／Telegram 確認），
  目前**沒有合併**。如果之後合併，不要同時把 Grok Bot 接到兩邊，不然同一筆單要核准兩次。
- **登入過期**：登入大約 1 小時過期。這個伺服器過期時會自動重讀 `~/.foodpanda-mcp/token.json`，
  裡面有同一個帳號較新的登入就直接用，**不用重啟**。但 mcp-check 不提供 `refresh_token`，
  所以要由別的方式重新登入、更新這個檔案。同一個瀏覽器設定檔（`browser-data/`）不能同時被兩個程序開啟，
  所以在 mcp-check 執行中，用另一個程序登入很可能會失敗。目前可行的做法是：停掉 mcp-check，用一般 MCP client 呼叫 `refresh_token` 登入，
  再啟動 mcp-check。這部分還沒解決，見 [handoff.md](handoff.md)。
- **結果不明**：送出後沒收到明確回應時，這個伺服器會鎖住下一筆訂單；mcp-check 會把申請標成
  「結果待確認」。你在 foodpanda App 查過、在 mcp-check 手機 App 標記之後，下一筆才會解鎖。

## 給 mcp-check 讀的回應格式

`test/hub-contract.test.ts` 固定了 mcp-check 依賴的格式，改動前要一起看：

- `prepare_order` 回傳 JSON：`confirmation_code`、`expires_at`、`restaurant`、`items[]`
  （`name`、`quantity`、`options`、`special_instructions`、`total_price`）、`subtotal`、
  `delivery_fee`、`service_fee`、`total`、`currency`、`payment_method`、`delivery_address`、
  `delivery_instructions`。
- `place_order` 成功時回傳 JSON，有 `order_id`。
- `place_order` 失敗時，最後一行一定是下面其中一種：
  - `[checkout_sent: no] ...`：還沒送出，沒有下單。
  - `[checkout_sent: unknown] ...`：可能已經下單，要先到 foodpanda App 查。
- 依 toby 告知（2026-10-13），mcp-check 已改成只看 `[checkout_sent: no]` 標記，不再比對錯誤文字；
  **尚未對照 mcp-check 的程式碼確認**（之前看過的 mcp-check 版本還是比對文字）。
  `test/hub-contract.test.ts` 用的就是這條規則：沒有這個標記的錯誤一律當成「可能已下單」。
  錯誤內文若引用到 foodpanda 或網路錯誤的文字，裡面的 `checkout_sent` 字樣會被改成 `checkout-sent`，
  只有最後一行是真的標記。結帳請求一旦可能已送出，任何錯誤都只會得到 `[checkout_sent: unknown]` 並上鎖。
