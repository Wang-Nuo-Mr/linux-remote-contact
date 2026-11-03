# QQ每日在线检查与恢复

监控在阿里云服务器的`systemd timer`运行，不依赖你的电脑、Codex桌面应用或模型额度。按用户要求每24小时一次，服务器重启后也会检查。每日检查不能消除QQ会话本身的失效原因，可能出现最长接近一天才发现掉线的间隔；需要更快发现时可由管理员调整timer频率。

## 检查和恢复顺序

1. 同时检查OneBot在线状态与实际登录QQ号，不能只看容器运行、`good=true`或中枢健康。
2. 正常在线时不重登、不重启；只更新最近正常时间。
3. 掉线时先试已保存的设备会话。
4. 登录服务卡住时，每24小时最多重启一次现有QQ容器；不重建容器，不删除登录卷。
5. 如已配置密码登录摘要，再尝试一次密码登录。
6. 碰到验证码、新设备确认、账号不符或缓存无法恢复时记录需要本人处理，不绕过验证，不循环猜密码。

恢复尝试有24小时冷却，状态在`/var/lib/linux-contact/qq-watchdog/status.json`，root:contact可读，不含密码、令牌或验证码URL。创造者私聊`/运维状态`可查看；QQ离线时当然无法靠QQ传回这条状态。

## 密码配置

不要把QQ密码发到聊天、提交Git或写进systemd命令。当前机器提供本地私密文件`server-access/QQ自动登录.local.env`，只在`QQ_PASSWORD=`后填写并保存；文件由当前Windows用户私有，目录已被Git忽略。

授权安装时，本地助手在内存计算登录所需摘要，通过已有SSH通道的标准输入交给`tools/install_qq_secret.py`。服务器保存为`/etc/linux-contact/qq-login.secret.json`，root:root、600；成功后清空本地明文。摘要同样属于敏感凭据，并不等于可以公开的加密密码；运行QQ聊天和任务的contact用户不能读取它。

即使设备在QQ设备管理里，平台仍可能要求本人确认，脚本不能保证每次无人值守登录。验证码或新设备验证需要本人处理，失败结果会留档。

## 管理命令

```bash
systemctl status qq-watchdog.timer
systemctl list-timers qq-watchdog.timer
systemctl status qq-watchdog.service
# 只检查，不恢复
python3 /usr/local/lib/linux-contact/qq_watchdog.py --check-only
# 本人授权后额外尝试一次恢复；仍不会在一天内反复重启容器
python3 /usr/local/lib/linux-contact/qq_watchdog.py --force
```

运行脚本用root，只为读取受限凭据和重启固定名称`contact-ecs-napcat-1`的容器。不给中枢或Codex添加Docker权限，不开放新的公网端口。默认优先复用会话，不要求保存密码。
