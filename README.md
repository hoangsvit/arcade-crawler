# Arcade tier crawler

Crawler này lấy số chỗ còn lại từ Google Cloud Skills Boost Arcade và
publish mảng JSON vào Firebase Remote Config.

Yêu cầu Node.js 24 trở lên.

Dữ liệu mới nhất được lưu tại `data/arcade_milestones.json`.

## Firebase

Sao chép `.env.example` thành `.env`:

```bash
cp .env.example .env
```

Sau đó chỉnh nội dung `.env`:

```dotenv
PUBLISH_REMOTE_CONFIG=false
FIREBASE_REMOTE_CONFIG_KEY=arcade_milestones
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"your-project-id",...}
```

Mặc định crawler chỉ lấy dữ liệu và không publish. Chạy crawler:

```bash
npm start
```

Để publish lên Firebase, đổi `PUBLISH_REMOTE_CONFIG=true` trong `.env`.
File `.env` đã được Git ignore và không được commit.

### Vì sao không dùng `WXT_FIREBASE_*`?

Các biến như `WXT_FIREBASE_API_KEY`, `WXT_FIREBASE_AUTH_DOMAIN` và
`WXT_FIREBASE_APP_ID` là Firebase Web SDK config dành cho WXT extension hoặc
frontend. Prefix `WXT_` khiến biến được đưa vào client bundle và đọc bằng
`import.meta.env`.

Crawler này là ứng dụng Node.js và cần quyền quản trị để thay đổi Remote Config,
nên dùng Firebase Admin SDK với:

```dotenv
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

Firebase Web API key chỉ nhận diện project/app; nó không cấp quyền publish
Remote Config. Không đặt service account private key vào biến có prefix `WXT_`
vì dữ liệu đó có thể bị đóng gói vào extension và lộ ra phía client.

### Lấy `FIREBASE_SERVICE_ACCOUNT_JSON`

1. Mở [Firebase Console](https://console.firebase.google.com/).
2. Chọn Firebase project cần cập nhật Remote Config.
3. Mở **Project settings** (biểu tượng bánh răng).
4. Chọn tab **Service accounts**.
5. Trong phần **Firebase Admin SDK**, nhấn **Generate new private key**.
6. Xác nhận bằng **Generate key** để tải file JSON xuống.

Mở file vừa tải và sao chép toàn bộ nội dung JSON vào `.env` trên một dòng:

```dotenv
PUBLISH_REMOTE_CONFIG=true
FIREBASE_REMOTE_CONFIG_KEY=arcade_milestones
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"your-project-id","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-...@your-project-id.iam.gserviceaccount.com","client_id":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token"}
```

Giữ nguyên các ký tự `\n` bên trong `private_key`; không chuyển chúng thành
dòng mới trong file `.env`.

Service account cần quyền cập nhật Firebase Remote Config, ví dụ role
**Firebase Remote Config Admin**. Không commit `.env` hoặc file JSON private key
lên GitHub.

Với GitHub Actions, vào **Settings → Secrets and variables → Actions → New
repository secret**, tạo secret tên `FIREBASE_SERVICE_ACCOUNT_JSON` và dán toàn
bộ nội dung file JSON vào giá trị của secret.

## GitHub Actions

Workflow `.github/workflows/update-arcade-milestones.yml` chạy mỗi ngày lúc
00:00 UTC (07:00 giờ Việt Nam) và cũng có thể chạy thủ công bằng
`workflow_dispatch`. Workflow đặt `PUBLISH_REMOTE_CONFIG=true`, nên dữ liệu sẽ
được publish lên Firebase. Nếu file `data/arcade_milestones.json` thay đổi,
workflow cũng tự commit và push file mới bằng `github-actions[bot]`.

Tại **Settings → Secrets and variables → Actions**, cấu hình:

- Secret `FIREBASE_SERVICE_ACCOUNT_JSON`: toàn bộ nội dung file service account
  JSON.
- Variable `FIREBASE_PROJECT_ID`: Firebase project ID. Variable này không bắt buộc nếu
  service account JSON đã có `project_id`.

Service account cần quyền cập nhật Firebase Remote Config, ví dụ role
`Firebase Remote Config Admin`.
