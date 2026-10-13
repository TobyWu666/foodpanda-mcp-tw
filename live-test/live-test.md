# 第一次實測（在 toby 的電腦上，不下單）

目的：確認在真的 foodpanda 台灣網站上，下面這些都能用：登入、搜尋、菜單、購物車驗價、列付款方式、準備訂單。

**全程不會呼叫 `place_order`，不會下單。** 腳本裡寫死了：碰到 `place_order` 就直接停。準備訂單時拿到的確認碼不會被使用，結束時購物車會清空。

腳本：[live-check.mjs](/mnt/project-files/foodpanda-mcp-tw/live-test/live-check.mjs)

## 要準備什麼

- 你的電腦上要有 Node 20 以上，能開 Chrome／Chromium 視窗（登入時要用）。
- 你外送地址的座標（緯度、經度）。**只在你自己的終端機輸入，不要寫進任何檔案或貼到專案裡。**
- 大約 10 分鐘。

## 步驟（由在你電腦上的 Claude 照著做，你只需要登入和看結果）

1. 取得程式（PR #6、#7 都已合併到 main）：
   ```sh
   cd ~ && git clone https://github.com/TobyWu666/foodpanda-mcp-tw.git foodpanda-mcp-tw-live
   cd foodpanda-mcp-tw-live
   npm install && npx playwright install chromium && npm run build
   ```

2. 把腳本放到電腦上，例如 `~/foodpanda-live-check.mjs`。共用資料夾裡那份內容一樣。

3. 第一次執行，會開瀏覽器讓你登入：
   ```sh
   cd ~/foodpanda-mcp-tw-live
   FOODPANDA_LATITUDE=你的緯度 FOODPANDA_LONGITUDE=你的經度 \
     node ~/foodpanda-live-check.mjs --login --query 麥當勞 --payment cash
   ```
   - 瀏覽器開啟後，你用平常的方式登入 foodpanda（可能要輸入簡訊驗證碼）。登入後程式會自動抓到登入狀態，存在 `~/.foodpanda-mcp/`，不會進 git。
   - 如果你存了不只一個地址，`prepare_order` 會列出所有地址和編號。用 `--address 編號` 再跑一次，第二次不用 `--login`。

4. 再跑一次 LINE Pay（一樣不會扣款）：
   ```sh
   FOODPANDA_LATITUDE=… FOODPANDA_LONGITUDE=… \
     node ~/foodpanda-live-check.mjs --payment linepay [--address 編號]
   ```

## 每一步要看什麼

| 步驟 | 正常的樣子 | 有問題時先看 |
|---|---|---|
| 登入 `refresh_token` | 「token captured」之類的訊息 | 確認是不是**訪客 token**（還沒解決的待辦）：如果之後購物車回 401，表示抓到的是訪客 token |
| 搜尋 `search_restaurants` | 列出附近的麥當勞等店家 | 被拒或 403：審核提過的兩個 header 差異（搜尋多帶了 `x-pd-language-id`、少了 `apollographql-client-version`）；hash 失效時錯誤會說要重抓哪一個 |
| 餐廳／菜單 | 營業狀態正確、有分類和品項 | `PersistedQueryNotFound` → 跑 `scripts/discover-hashes.mjs` |
| 加購物車 `add_to_cart` | 小計、外送費、服務費和 app 裡一樣（app 會多一個 3 元塑膠袋，正常） | 有必選選項的品項，腳本會自動選每組第一個；不支援的選項類型會被擋下，這是預期行為 |
| 付款方式 `list_payment_methods` | `cash` 可用；有綁 LINE Pay 時 `linepay` 也可用；信用卡列在「不支援」 | `linepay` 不可用時看原因，例如「沒有綁定」 |
| 準備訂單 `prepare_order` | 品項、選項、金額、付款方式、**地址**都正確，有一組確認碼 | 金額和 app 不同：記下差多少（已知限制：驗價只用座標，沒有帶「已存地址」那一塊） |

最後會印出摘要，每一步是 OK 還是 ERROR，並寫「no order was placed」。

輸出裡的地址只顯示開頭 3 個字加 `***`（例如「台北市***」），夠你認出是哪個地址。電話、email、座標一律換成 `***`。不過搜尋結果裡的附近店家還是看得出你住哪一區，所以輸出開頭會提醒：**不要公開貼出**。

## 跑完之後

- 把摘要（OK／ERROR 那幾行）和錯誤訊息回報給專案。**不要貼地址、姓名、電話、座標或 token。** 錯誤訊息本身已經去掉個資，但貼之前還是看一下。
- 全部 OK 的話，下一步由你決定要不要下第一張**小額現金**真實訂單，用來確認結帳格式：
  - 程式很可能會回「狀態不明」，因為台灣的結帳回應沒錄過，程式只接受 foodpanda 明說成功的回應。
  - 這時到 app 看訂單有沒有成立就好。
  - 那次要另外錄下結帳的請求和回應（照之前的錄製方式，遮蔽後再分享），用來寫出台灣真正的成功格式。
- 跑完後可以刪掉 `~/foodpanda-mcp-tw-live`。登入狀態在 `~/.foodpanda-mcp/`，要清掉就刪那個資料夾。
