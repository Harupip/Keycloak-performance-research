# Demo mở rộng Keycloak theo chiều ngang và xem cách hoạt động khi 1 node / nhiều node gặp sự cố

Dự án này khởi chạy một cụm Keycloak nhỏ phía sau HAProxy, đồng thời Prometheus thu thập số liệu thời gian thực để bạn quan sát khả năng chịu tải và tính ổn định khi lưu lượng tăng lên.

## Yêu cầu

- Docker + Docker Compose v2

## Khởi động Postgres, Keycloak và HAProxy

1. Bật Postgres và node Keycloak đầu tiên (để migrations chạy an toàn):
   ```bash
   docker compose up -d postgres keycloak-1
   ```
2. Chờ tới khi `keycloak-1` có trạng thái `healthy`:
   ```bash
   docker compose ps keycloak-1
   ```
3. Khởi động các replica còn lại cùng HAProxy và hệ thống giám sát:
   ```bash
   docker compose up -d keycloak-2 keycloak-3 haproxy prometheus grafana haproxy-exporter postgres-exporter
   ```

Tập tin compose tạo sẵn tài khoản quản trị (`admin`/`admin`), cấu hình Keycloak dùng `JDBC_PING` để chia sẻ cache, và kết nối HAProxy làm entrypoint để các container Keycloak tự khám phá lẫn nhau thông qua Postgres.

Nếu bạn chạy Docker trên Linux và muốn thu thập thêm số liệu host, hãy bật profile exporter:
```bash
docker compose --profile host-metrics up -d node-exporter
```

Mẹo: khi demo trực tiếp, bạn có thể trì hoãn bước 3, giữ lưu lượng trỏ vào `keycloak-1`, sau đó bật thêm replica khi bài test đang diễn ra.

## Kiểm tra cụm

1. Đảm bảo tất cả container Keycloak đều `healthy`:
   ```bash
   docker compose ps keycloak-1 keycloak-2 keycloak-3
   ```
2. Gọi Keycloak qua HAProxy và xem header `X-Upstream-Server`:
   ```bash
   curl -i http://localhost/realms/master/.well-known/openid-configuration | grep X-Upstream-Server
   ```
   Lặp lại nhiều lần, bạn sẽ thấy giá trị upstream thay đổi giữa các container. HAProxy thêm header này để dễ nhận biết node xử lý yêu cầu.
   Trên PowerShell hãy dùng:
   ```powershell
   curl.exe -i http://localhost/realms/master/.well-known/openid-configuration | Select-String X-Upstream-Server
   ```
   (`curl.exe` gọi đúng binary cURL, nên option `-i` hoạt động như mong đợi.)

## Xem thông số & dashboard

- **Prometheus:** mở [http://localhost:9090](http://localhost:9090). Vào `Status > Targets` để chắc job `keycloak` (cổng 9000) và `haproxy` (cổng 8404) xanh. Ví dụ 1 số cái query có thể lấy trong đây:
  - `vendor:requests:count` – lưu lượng tới Keycloak, có nhãn `node`.
  - `base_gc_time_seconds_total` – thời gian GC JVM, giúp phát hiện áp lực bộ nhớ.
  - `haproxy_frontend_http_requests_total` – tốc độ request/giây ở HAProxy.
  - `haproxy_server_up{server="keycloak-2"}` – node còn sống (1) hay đã bị loại (0).
- **Grafana:** đăng nhập [http://localhost:3000](http://localhost:3000) với `admin/admin`. Datasource Prometheus đã provision sẵn:
  - Tạo dashboard gồm các panel latency (p95, p99), tỷ lệ lỗi (`haproxy_server_http_responses_total{code="5xx"}`), CPU/GC Keycloak (`process_cpu_seconds_total`), session (`keycloak_session_count`).
  - Nếu bạn export JSON từ k6, import vào Grafana để vẽ biểu đồ theo thời gian.
- **HAProxy stats:** [http://localhost:8404/stats](http://localhost:8404/stats) cho biết trạng thái từng backend, hàng đợi, tỷ lệ retry. Khi node bị kill, trạng thái chuyển `DOWN` sau ~6 giây (do cấu hình `inter 2000`, `fall 3`).
- **Theo dõi từ k6:** cuối mỗi test chú ý các metric `http_req_duration`, `http_req_failed`, `keycloak_upstream_latency`. Bạn có thể thêm `--out json=results.json` để phân tích chi tiết.

## Tạo tải tự động với k6

1. Cài [k6](https://k6.io/docs/getting-started/installation/) (Windows: `choco install k6`).
2. Khi stack đã chạy, dùng helper PowerShell để khỏi gõ nhiều biến môi trường:
   ```powershell
   # 100 request mỗi 30 giây trong 10 phút
   .\scripts\run-k6.ps1 -BaseUrl http://localhost -RequestRate 100 -TimeUnit 30s -Duration 10m
   ```
   Đổi `-Script keycloak-login-refresh` nếu muốn kiểm tra luồng đăng nhập + refresh token.
   Ramp script moi `keycloak-login-ramp` giup ramp luu luong GET OpenID Discovery (khong can dang nhap):
   ```powershell
   .\scripts\run-k6.ps1 -Script keycloak-login-ramp -TimeUnit 1m -K6Args @('--tag','profile:ramp')
   ```
   Co the thay doi bien moi truong `RAMP_STAGES`, vi du: `RAMP_STAGES="1m:20,2m:60,2m:100,1m:0"`. `RAMP_START_RATE` va `RAMP_GRACEFUL_STOP` ho tro dieu chinh toc do bat dau va thoi gian dung nhe.
3. Khi cần tuỳ biến sâu, truyền thêm `-K6Args '--out json=results.json'` hoặc chỉnh `-PreAllocatedVUs`, `-MaxVUs`.
4. Trực tiếp (không dùng helper):
   ```bash
   BASE_URL=http://localhost k6 run perf/k6/keycloak-openid.js
   ```
   Script `keycloak-openid` ramp VU lên 30, gọi OpenID Discovery và ghi nhận latency theo từng upstream.

## Kiểm tra khả năng SSO khi đúng node đăng nhập bị dừng

- Dùng `scripts\failover-login.ps1` để mô phỏng: đăng nhập vào một node cụ thể, kill node đó, sau đó refresh token qua HAProxy:
  ```powershell
  .\scripts\failover-login.ps1 -DirectNodeUrl http://localhost:8081 -TargetNode keycloak-2 -AutoRestart
  ```

- Kết hợp với k6: chạy `run-k6.ps1` song song rồi dùng script failover, xem các VU có tiếp tục refresh/token hay không.

## Mô phỏng node hỏng thủ công

1. Giữ tải chạy k6.
2. Liệt kê container:
   ```bash
   docker compose ps keycloak-1 keycloak-2 keycloak-3
   ```
3. Dừng một replica (có thể tắt ở docker), ví dụ:
   ```bash
   docker compose kill keycloak-2
   ```
4. Tiếp tục curl `http://localhost/realms/master/.well-known/openid-configuration` và quan sát header `X-Upstream-Server`. Sau vài giây, lưu lượng ổn định về các node còn khỏe. HAProxy tự retry theo `option redispatch`.
5. Bật lại replica khi cần:
   ```bash
   docker compose up -d keycloak-2
   ```

## Kết thúc phiên thử nghiệm

Tắt toàn bộ stack và xoá volume:
```bash
docker compose down -v
```

