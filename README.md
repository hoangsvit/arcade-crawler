# Arcade Tier Crawler

Tự động crawl dữ liệu milestone từ **Google Cloud Skills Boost Arcade** và publish lên **Firebase Remote Config** mỗi 6 giờ.

---

## Lần chạy gần nhất

<!-- LAST_RUN_START -->
16/07/2026 06:47:51 (GMT+7)
<!-- LAST_RUN_END -->

---

## Yêu cầu

- Node.js 24+
- Playwright (Chromium)
- Firebase project với Remote Config

Dữ liệu crawl được lưu tại [`data/arcade_milestones.json`](data/arcade_milestones.json).

---

## Cài đặt & chạy local

### 1. Cấu hình môi trường

```bash
cp .env.example .env
```

Chỉnh `.env`:

```dotenv
PUBLISH_REMOTE_CONFIG=false
FIREBASE_REMOTE_CONFIG_KEY=arcade_milestones
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

> Mặc định `PUBLISH_REMOTE_CONFIG=false` — crawler chỉ lưu file local, không push lên Firebase.

### 2. Chạy crawler

```bash
npm install
npm start
```

---

## Cấu hình Firebase

### Lấy Service Account

1. Mở [Firebase Console](https://console.firebase.google.com/) → chọn project.
2. **Project settings** → tab **Service accounts**.
3. **Generate new private key** → tải file JSON.
4. Sao chép toàn bộ nội dung vào `FIREBASE_SERVICE_ACCOUNT_JSON` trên **một dòng**:

```dotenv
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"..."}
```

> Giữ nguyên `\n` bên trong `private_key`. Không chuyển thành dòng mới thực.

Service account cần role **Firebase Remote Config Admin**.

---

## GitHub Actions

Workflow [`update-arcade-milestones.yml`](.github/workflows/update-arcade-milestones.yml) tự chạy mỗi **6 tiếng** (00:00 / 06:00 / 12:00 / 18:00 giờ Việt Nam) và hỗ trợ chạy thủ công qua `workflow_dispatch`.

Sau mỗi lần chạy, workflow tự commit:

- `data/arcade_milestones.json` nếu dữ liệu thay đổi.
- `README.md` với thời gian chạy mới nhất.

### Secrets & Variables

Vào **Settings → Secrets and variables → Actions**:

- **Secret** `FIREBASE_SERVICE_ACCOUNT_JSON` — toàn bộ nội dung file service account JSON.
- **Variable** `FIREBASE_PROJECT_ID` — Firebase project ID.

> `FIREBASE_PROJECT_ID` không bắt buộc nếu service account JSON đã có `project_id`.
