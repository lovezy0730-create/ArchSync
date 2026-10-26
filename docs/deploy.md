# ArchSync 部署指南

本指南覆盖从本机演示到局域网/服务器部署的路径。**尚未执行的部署步骤（公网上线、HTTPS 证书、反向代理配置）需要部署者自行完成**——本文是部署前的完整准备。

## 部署形态与鉴权模式

| 场景 | 鉴权 | 说明 |
|---|---|---|
| 本机演示 | `DEV_AUTH_MODE=mock`（默认） | 仅允许 `HOST=127.0.0.1`；访客自填显示名 |
| 局域网/服务器 | `AUTH_CODE=<≥8字符访问码>` | 首次访问需输入访问码换取 HttpOnly 会话 Cookie（12h）；非回环绑定且无 AUTH_CODE 时**服务拒绝启动** |
| 公网 | `AUTH_CODE` + HTTPS 反向代理 | Cookie 自动带 `Secure`（NODE_ENV=production 时）；WSS 走代理 |

## 方式 A：Docker（推荐）

```bash
# 准备环境变量（或写入同目录 .env 文件）
export AUTH_CODE='换成你的访问码'
export GITHUB_TOKEN='github_pat_xxxx'   # 可选：接入真实 GitHub 数据

docker compose up -d --build
# 打开 http://<服务器IP>:4310
```

- 数据（快照、备注）持久化在 `archsync-data` 卷（容器内 `/data`）。
- 端口映射在 `docker-compose.yml` 的 `ports` 修改。
- **注意**：容器内扫描的是镜像内的 `examples/` 示例项目。要扫描你自己的仓库，见下方「扫描目标」。

## 方式 B：Windows / Linux 直接运行

```bash
git clone https://github.com/lovezy0730-create/ArchSync.git
cd ArchSync
pnpm install
# .env 至少设置：
#   HOST=0.0.0.0
#   AUTH_CODE=<≥8字符访问码>
#   GITHUB_TOKEN=<可选>
pnpm start        # 自动构建前端并启动，单端口 4310
```

用 NSSM / systemd / pm2 注册为常驻服务时，启动命令即 `pnpm start`（工作目录为仓库根）。

## 扫描目标

服务端自动发现**运行目录**下的 `.archsync/project.yaml` 与 `examples/*/.archsync/project.yaml`：

- 想让 ArchSync 展示你自己的项目：把 `project.yaml` 放进部署机的目标仓库根目录，然后让部署机的 ArchSync 检出该仓库（或在目标仓库内运行 ArchSync）。扫描永远是**只读**的（固定 git 子命令白名单，不执行仓库代码）。
- Docker 场景：把目标仓库挂载进容器并在容器内放置配置，例如
  `volumes: - /path/to/your-repo:/workspaces/your-repo`，同时设置 `WORKSPACE_ROOT=/workspaces`（启动时服务会在该目录发现项目；该环境变量在 `pnpm start` / 直接运行时同样生效——若你的镜像基于旧版本，请升级后使用）。

## HTTPS / WSS

ArchSync 自身只提供 HTTP/WS；公网部署必须在前面放 TLS 代理（Caddy/Nginx/Traefik）。要点：

- 代理到 `<host>:4310`，WebSocket 升级请求需要 `Upgrade`/`Connection` 头透传（Caddy 自动处理；Nginx 见下）。
- `NODE_ENV=production` 时会话 Cookie 自动带 `Secure`，只经 HTTPS 传输。
- 代理层建议限制请求体大小（API 上限 4 MiB）。

```nginx
location / {
    proxy_pass http://127.0.0.1:4310;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

## 健康检查与运维

- `GET /healthz` — 存活探针（PaaS/负载均衡用）。
- 状态文件：容器内 `/data/archsync-state.json`（卷持久化）；直接运行时 `.local/archsync-state.json`。损坏时服务自动备份为 `*.corrupt-<ts>` 并空状态启动。
- 日志：stdout，前缀 `[archsync]`；令牌与访问码不落日志。
- 升级：拉新代码 → `docker compose up -d --build`（数据在卷中保留）。

## 安全清单（部署前逐项确认）

- [ ] `AUTH_CODE` 已设置且 ≥ 8 字符，只通过私密渠道分发给团队成员
- [ ] 公网部署走 HTTPS（Cookie Secure 标志依赖 `NODE_ENV=production`）
- [ ] `GITHUB_TOKEN` 使用最小权限只读 PAT，且仅在服务端环境注入
- [ ] 反向代理未把 `/healthz` 之外的任意后端路径暴露给不受信网络之外
- [ ] 定期备份 `/data/archsync-state.json`（单文件，直接复制即可保持一致性，建议停写窗口内备份）
- [ ] 知道如何回滚：`docker compose down` + 上一版本镜像；数据卷独立于镜像生命周期
