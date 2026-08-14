# 荷香早餐店點餐系統

顧客用手機掃 QR Code 點餐 → 訂單即時同步到嬤嬤的平板出餐看板。媽媽可以自己在後台改菜單價格、上下架品項。

## 三個網頁

| 網址 | 給誰用 | 用途 |
|---|---|---|
| `/customer.html` | 顧客手機 | 點餐、送出訂單 |
| `/kitchen.html` | 嬤嬤的平板 | 出餐看板，即時看到新訂單，完成並收款 |
| `/admin.html` | 媽媽 | 改價格、上下架品項、新增餐點 |

## 部署到 Railway（步驟）

### 1. 把專案傳到 GitHub
```bash
cd breakfast-order-system
git init
git add .
git commit -m "早餐店點餐系統"
```
接著在 GitHub 建一個新的 repository（例如 `breakfast-order-system`），照畫面指示把本地專案 push 上去：
```bash
git remote add origin https://github.com/你的帳號/breakfast-order-system.git
git branch -M main
git push -u origin main
```

### 2. 連接 Railway
1. 到 [railway.app](https://railway.app) 用 GitHub 帳號登入
2. 點 **New Project → Deploy from GitHub repo**，選你剛剛建立的 repo
3. Railway 會自動偵測到 `package.json`，執行 `npm install` 後跑 `npm start`
4. 部署完成後，Railway 會給你一組網址，例如 `https://breakfast-order-system-production.up.railway.app`

### 3. 設定管理密碼（重要）
在 Railway 專案的 **Variables** 分頁新增一個環境變數：
```
ADMIN_PIN=你自訂的4-6碼密碼
```
這組密碼是進 `/admin.html` 改菜單用的，設完後 Railway 會自動重新部署。若不設定，預設密碼是 `0000`（建議一定要改掉）。

### 4. 之後要改程式碼
本機改完檔案後：
```bash
git add .
git commit -m "說明這次改了什麼"
git push
```
push 上去 Railway 就會自動重新部署，不用手動操作。

## 產生顧客點餐用的 QR Code

拿到 Railway 網址後，把 `/customer.html` 接在後面，例如：
```
https://breakfast-order-system-production.up.railway.app/customer.html
```
用任何免費 QR Code 產生網站（例如 qr-code-generator.com）把這個網址轉成 QR Code，印出來貼在店裡櫃檯或桌上即可。

嬤嬤平板固定開著：
```
https://breakfast-order-system-production.up.railway.app/kitchen.html
```
建議加到平板瀏覽器的主畫面捷徑，開機後直接點就進去。

## 資料儲存說明

菜單和訂單存在 `data-store/store.json`，這個資料夾**必須在 Railway 掛載永久硬碟（Volume）**，不然每次重新部署資料都會被清空。設定方式如下（只要設定一次）：

1. 到 Railway 專案，點進你的服務
2. 點「Settings」分頁，找到「Volumes」區塊，點「New Volume」（或「Add Volume」）
3. **Mount Path 一定要填：** `/app/data-store`
4. 儲存，Railway 會自動重新部署一次
5. 之後不管你怎麼更新程式碼、上傳新檔案，訂單紀錄跟菜單設定都會留著

⚠️ 如果還沒設定這個 Volume，資料還是會在每次重新部署時消失，跟之前一樣。

## 本機測試（可選）

如果想在自己電腦先測試再部署：
```bash
npm install
npm start
```
然後打開瀏覽器到 `http://localhost:3000/customer.html`、`http://localhost:3000/kitchen.html`、`http://localhost:3000/admin.html` 分別測試三個頁面。
