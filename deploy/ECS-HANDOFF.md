# Ubuntu 22.04 ECS 交接

本路线仅 NapCat 使用 Docker，hub 以 contact 原生运行。不要叠加项目根目录的其他 Compose 文件，也不要启动 hub 容器。系统管理命令由管理员执行，不要给 contact 加 sudo 或 docker 组权限。末尾区分了受限 Codex 准备阶段与真实服务器上的验证结果。

## 1. 管理员准备

- 安装官方 Docker Engine 和 Compose 插件，确保 docker.service 开机启动。不要下载执行未知脚本。Node 已知为 24.22.2，Codex 已知为 0.166.0；本项目无第三方运行依赖，无需 npm install。
- 确认 `/usr/local/bin/node`、`/usr/local/bin/codex` 可被 contact 执行；后者是已有代理包装入口，负责 Codex 到宿主机 `127.0.0.1:7890` 的连接。本项目不修改包装器或代理，不将宿主代理挂入 NapCat。
- 检查现有路由和 Docker 网络，确认 `172.30.70.0/24` 不冲突。只保留既有公网 SSH 22 访问；不向安全组、公网防火墙或反向代理发布 3000、3789、6099。
- 管理员根据 `deploy/ecs.env.example` 单独创建项目根目录 `.env`（不要直接使用示例启动），用安全方式填写四个不同的随机密钥，各至少32字符，不在终端打印、聊天或提交密钥。不要读取或打印 Codex 认证文件；复用 contact 已有登录。
- `NAPCAT_UID/GID` 是容器用户的数字标识，示例为1000；两个命名卷不直接绑定宿主机 contact 目录。`ALLOWED_USERS/ALLOWED_GROUPS` 初始留空，默认拒绝所有 QQ 用户；部署时由本人确认控制账号，群聊另填允许的群号。
- 以下命令只处理项目运行目录和权限，不修改认证目录内容：

```bash
cd /var/lib/linux-contact/app
install -d -o contact -g contact -m 700 data workspace
chown contact:contact .env
chmod 600 .env
```

示例变量均有代码或 Compose 消费方；`WEBUI_TOKEN` 和 `NAPCAT_UID/GID` 仅供 Compose。Compose 不把完整 `.env` 注入 NapCat，以免泄漏管理密钥。下列 `--env-file .env` 指项目根目录文件，也就是部署文件相对位置的 `../.env`；必须显式指定，不能依赖当前目录自动查找。不要用会打印已解析密钥的 `docker compose config`（无 `--quiet`）。

## 2. 先创建 NapCat 网桥，再启动 hub

以下命令由管理员在项目根目录执行：

```bash
docker compose --env-file .env -f deploy/ecs-compose.yaml config --quiet
docker compose --env-file .env -f deploy/ecs-compose.yaml pull napcat
docker compose --env-file .env -f deploy/ecs-compose.yaml up -d napcat
docker compose --env-file .env -f deploy/ecs-compose.yaml ps
ip -4 route show 172.30.70.0/24
systemd-analyze verify deploy/ecs-codex.service
install -o root -g root -m 644 deploy/ecs-codex.service /etc/systemd/system/ecs-codex.service
systemctl daemon-reload
systemctl enable --now ecs-codex.service
systemctl status ecs-codex.service --no-pager
```

Compose 固定项目名 `contact-ecs`，独立 bridge 网段 `172.30.70.0/24`、网关 `172.30.70.1`；宿主机仅映射 `127.0.0.1:3000` 和 `127.0.0.1:6099`。两个命名卷分别保存 NapCat 配置与 QQ 登录数据，无 Docker socket、宿主目录挂载或 privileged 配置。容器日志最多 3 × 10MB。

hub 监听网桥地址 `172.30.70.1:3789`，不能在创建网桥前启动。systemd 依赖 Docker，但不自动执行 Compose；重建网桥或维护 Docker 后，管理员应先确认 NapCat 已启动再重启 hub。重启策略允许常规服务器重启后 Docker 恢复容器；若网桥恢复过慢触发启动次数限制，确认网桥后执行 `systemctl reset-failed ecs-codex` 和 `systemctl start ecs-codex`。

systemd 只允许 data、workspace、CODEX_HOME 和私有临时目录写入；CODEX_HOME 可写以支持认证刷新。保留 Codex 所需用户命名空间与挂载能力，不设 RestrictNamespaces、MemoryDenyWriteExecute 或阻断网络的限制；NoNewPrivileges 等保护不替代 Codex 自身沙箱。服务未获 docker 组或提权能力。保护组合在真实 systemd/Codex 沙箱内仍需管理员联调，不应以关闭沙箱解决失败。

## 3. 本人扫码与 OneBot 配置

在自己的电脑建立 SSH 隧道，将 `服务器地址` 替换为实际地址（SSH 端口22）：

```bash
ssh -p 22 -N -L 6099:127.0.0.1:6099 -L 3789:172.30.70.1:3789 管理员账号@服务器地址
```

上述 SSH 账号和密钥需要允许端口转发；本次部署的自动化专用密钥带 restrict 限制，不能用于该隧道，须使用你自己的管理员登录方式。打开本机 `http://127.0.0.1:6099`，以 WEBUI_TOKEN 登录 NapCat WebUI；本人扫码确认自己的 QQ。打开本机 `http://127.0.0.1:3789` 可用 ADMIN_TOKEN 查询管理状态。两个 Web 端口都不公开。

在 NapCat v4.18.42 中配置并启用：

| 连接 | 配置 |
| --- | --- |
| HTTP 服务端 | 容器内监听 `0.0.0.0:3000`，token 填 ONEBOT_TOKEN；hub 使用该值作为 Bearer token 调用 send_msg |
| HTTP 客户端 | 上报地址 `http://172.30.70.1:3789/api/onebot/event`，token 填 ONEBOT_SECRET；该 token 用于生成 `x-signature: sha1=...`，HMAC-SHA1 输入是原始请求体 |
| 消息格式 | `array`，启用消息事件上报 |

HTTP 客户端 token 与 HTTP 服务端 token 用途不同，不能互换；WEBUI_TOKEN 仅管理 NapCat，ADMIN_TOKEN 仅管理 hub。若无签名或返回401，检查 HTTP 客户端 token，不要关闭验签。保存配置后按 UI 要求重启连接。

管理员经本人确认后填写 ALLOWED_USERS，必要时填写 ALLOWED_GROUPS，再执行 `systemctl restart ecs-codex`。群聊必须同时满足用户白名单、群白名单与 @ 机器人。仅更改 hub 变量需重启 hub；更改 NapCat 环境需重新运行上述 Compose `up -d`，单纯 restart 不更新环境。

## 4. 检测与验收

```bash
cd /var/lib/linux-contact/app
npm run check
npm test
curl --fail --silent --show-error http://172.30.70.1:3789/healthz
# 无签名请求必须返回401，不触发模型调用：
curl --silent --output /dev/null --write-out '%{http_code}\n' -H 'Content-Type: application/json' --data '{}' http://172.30.70.1:3789/api/onebot/event
ss -ltn | awk '$4 ~ /:(3000|3789|6099)$/ {print}'
systemctl is-active ecs-codex.service
docker compose --env-file .env -f deploy/ecs-compose.yaml ps
```

预期仅 `172.30.70.1:3789`、`127.0.0.1:3000`、`127.0.0.1:6099`；Docker 某些实现不显示用户态监听，需同时核对 Compose 端口和宿主规则。外部电脑无法直接访问这些公网端口。`/healthz` 仅证明进程存活，不证明 QQ 登录、代理或模型调用成功。

先在白名单留空时发送 `/状态`，应无回复；加入本人后 `/状态` 应回复且不调用模型。群聊还需验证未白名单用户、未允许群、未 @ 情况均不回复。

以下需要本人在 QQ 端验收，会使用账户额度：普通聊天；`/记忆` 检查长期记忆，验证私聊与群/其他用户隔离；长回答检查编号分段完整；`/干活 创建一个简单文本文件` 核对实际任务内容后才 `/确认 确认码`；用 `/结果`、`/文件` 检查产物。同一确认码不得再次执行，跨会话和过期确认码应拒绝。后台的真实模型与沙箱检查结果另见末尾。

自动测试使用本地 HTTP 模拟与 CLI stub，不需要账号或付费模型。CLI 0.166.0 参数检查通过（聊天 read-only、任务 workspace-write，never、ignore-user-config、ignore-rules、ephemeral、output-schema 等均支持）；管理员随后验证了实际推理和任务写入。忽略用户配置仍使用 CODEX_HOME 认证。

## 5. 日志、备份与回滚

hub 日志进 journal；需要排错时管理员本机查看 `journalctl -u ecs-codex -n 100 --no-pager`。NapCat 登录阶段日志可能带二维码或会话信息，不要公开粘贴完整日志或凭证。data/audit.jsonl 需要管理员定期归档，避免长期增长；备份 data、workspace、NapCat 两个命名卷和 `.env`，限制备份权限。不要备份到公开位置。

更新前停止 hub，停止 NapCat 后备份两个卷以保证一致性，记录当前部署文件/源码版本与镜像摘要。更新失败时：

```bash
systemctl stop ecs-codex.service
docker compose --env-file .env -f deploy/ecs-compose.yaml stop napcat
```

由管理员恢复上一个已验证源码、部署文件、环境和一致性数据备份；不要覆盖已有数据做试验。重新安装服务文件并 daemon-reload，先 Compose up -d，再启动 hub。暂时撤下服务可执行 `systemctl disable --now ecs-codex`，NapCat 用上述 stop；保留卷供恢复。不要使用 `down -v`、volume prune 或删除 data/workspace/登录卷。

在途消息采用内存队列，重启可能丢失；确认码重启失效，任务不会自动恢复或重试，旧 running 记录须人工核对。近期上下文最近6轮，长期记忆最多100条；维护不能擅自删除记忆或截断回答。Codex 沙箱不是同用户的机密文件隔离，白名单只能包含可信用户。

## 受限 Codex 准备阶段的验证记录

本次仅准备项目文件与无真实模型测试；当前无 docker 可执行文件，未做 Compose 实际解析、镜像拉取、Docker 网络/容器或 QQ 联调。服务安装、systemd 实际运行、认证刷新与生产沙箱验证均留给管理员。未创建运行时 `.env` 或真实密钥。

以上描述仅指服务器 Codex 的受限准备进程，不代表宿主机当前部署状态。管理员后续执行的验证见下节。

### 实际检查结果

- `npm run check`：通过。
- `npm test`：失败；Node 24.22.2 在原生层触发 `InternalCallbackScope::Close` 的 `execution_async_id == 0` 断言，三个测试文件均未完成。`node --test --test-concurrency=1` 同样失败；`node --test --test-isolation=none` 前三个配置/权限/签名测试通过后也原生崩溃。不能据此宣称全套测试通过。未更改产品代码来掩盖运行时崩溃；管理员须在实际宿主环境重跑并排查 Node 运行时，测试全部通过后再上线。
- PyYAML 解析及静态断言：通过，检查了单服务、固定镜像、网段/网关、回环端口、持久卷、有限环境注入、日志轮转、空白名单和变量消费方。这不等同于 Docker Compose 验证。
- `systemd-analyze verify deploy/ecs-codex.service`：未完成，当前缺少 `docker.service`，并出现受限环境权限/连接错误；未发现本服务文件的未知指令报告，仍需管理员安装 Docker 后重跑。

## 宿主机部署验证（2026-11-02）

- Ubuntu 22.04 x86_64，Node 24.22.2、Codex 0.166.0、Docker Engine 和 Compose 已安装；contact 没有 sudo 或 Docker 组权限。
- 在真实宿主机以 contact 运行全套 `npm test`：12项通过。上述原生断言只在准备代理的嵌套沙箱中复现，不作为实际宿主机测试结果。
- 运行时 `.env` 已单独创建，权限600；四种令牌独立生成；不提交运行时配置、QQ 登录卷或 Codex 认证。
- Compose 实际创建容器，命名卷和专用网桥已建立，hub systemd 服务已启用。健康检查成功；没有签名的 webhook 返回401。
- 在与生产 hub 相同的 systemd 用户、文件写入范围和保护选项下，真实 Codex 结构化聊天通过，workspace-write 创建指定检查文件通过；检查文件随后删除。没有写入聊天记忆，也没有代替用户确认 QQ 任务。
- 首次 NapCat v4.18.41 扫码后卡在 initializing、coreReady=false。升级固定镜像 v4.18.42、采用单进程兼容配置并由本人重新扫码后，QQ 状态 ready、coreReady=true；OneBot get_login_info 返回预期机器人账号，get_status 返回 online=true、good=true。
- 已看到主号私聊事件；OneBot 上报连接无401或连接错误，hub 无 message_failed/reply_failed。真实一轮聊天已落盘，用户本人确认 QQ 收发成功。记忆管理、长回复分段和 QQ 端任务确认流程已有自动测试，仍建议本人按需体验；本次未逐项执行真实 QQ 验收。

### 小群模式升级（0.3）

本次增加指定小群全消息判断、共享群上下文、按QQ号隔离的个人档案，以及独立的新成员列表。运行时身份配置放在 `/etc/linux-contact/identity.json`，root:contact、640，父目录750；`.env` 用 `COMPANION_IDENTITY_FILE` 指向它。创造者关系每轮注入，不进入可删除的普通记忆。个人资料不随源码上传，后续维护需单独备份该配置和 data/groups、data/memories。

升级先在独立 staging 目录通过全部14项 Linux 测试，再以生产同样的 systemd 保护设置实际调用 Codex，验证静默响应和无需@时回答创造者身份。切换前备份旧源码与运行环境，确认没有在途任务后只重启 hub；没有重启 QQ 容器，也没有清空私聊。新成员只获得该指定群的聊天与本人记忆操作权限，服务器任务与群管理仍由创造者操作。

用户本人已确认真实群回复成功；审计记录也确认不同成员的发言分别进入上下文，并出现主动沉默决策。首次调用较慢造成逐条排队，随后增加默认1.2秒连续消息合并及忙碌期间的下一批收集；新版15项 Linux 测试全部通过，实际 Codex 在同一批消息中正确选择沉默并把两位发言者的偏好分别标到各自QQ号。此真实模型检查未写入生产人物资料。管理命令形成批次边界；每批最多提取3条长期记忆，禁止更新未在该批发言的成员档案。
