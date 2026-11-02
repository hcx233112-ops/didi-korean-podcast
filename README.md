# Didi Korean Podcast

Next.js 播放器，音频由本机 Caddy 与 Cloudflare Tunnel 提供，视频列表由 GitHub Actions 更新，字幕由 Windows 定时任务生成。

## 本地运行与验证

```powershell
npm ci
npm run dev
npm test
npm run build
npm run test:e2e
npm audit --omit=dev
```

Node.js 20.9+；Python 3.11+。本地脚本依赖安装：

```powershell
python -m pip install -r scripts/requirements-automation.txt
```

音频处理需要 ffmpeg/ffprobe 在 PATH 中。先运行测试，再用 `scripts/setup-scheduler.ps1` 注册或更新任务。脚本和任务实际运行失败时返回非零退出码，`logs/*-status.log` 保存结构化状态；音频校验缓存基于文件大小、修改时间和预期时长失效。新音频先在临时目录生成，通过音轨与时长校验后替换旧文件。

## 私人云同步配置

本地收藏、备注和收听进度不依赖云同步。需要跨设备同步收藏和进度时，在部署环境配置：

```text
KV_REST_API_URL=<Redis REST HTTPS endpoint>
KV_REST_API_TOKEN=<Redis REST token>
PODCAST_SYNC_SECRET=<至少32个字符的随机密钥>
NEXT_PUBLIC_AUDIO_BASE=https://audio.yanxuan-kr.cn/
```

`PODCAST_SYNC_SECRET` 是服务端变量，不能加 NEXT_PUBLIC_ 前缀或写进仓库。可在自己的终端用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成，设置到部署环境后，所有自己的设备在页面的“云同步”设置中输入同一密钥。密钥保存在该浏览器本地，应只在自己的设备输入。这是私人单用户同步；不同访问者默认只能使用各自本地数据。

接口要求 Authorization Bearer 密钥，使用该密钥的哈希生成独立 Redis 键，并原子合并带修改时间的记录。取消收藏与重置进度保留删除标记，旧设备不会凭更大播放位置复活旧数据。旧浏览器数据自动迁移；旧的未认证 `podcast-sync` 全局键不会自动导入，避免重新引入来源不明的数据。换密钥会切换云端命名空间，本地数据继续保留。

没配置 KV/密钥返回 503，错误密钥返回 401，格式错误返回 400，过大数据返回 413，存储失败返回 502。前端显示失败并保留本地更改等待重试；无变化不反复写入，正常收听时按45秒节流，并在暂停或离开页面时尝试补写。

## 自动化与媒体

- 视频抓取：`.github/workflows/update-videos.yml`。
- 字幕：Windows 每日任务为主要入口；CI 作为手动备用，避免双重生产者同时修改同一字幕。
- 无字幕结果保留检查时间，七天后自动复查；指定视频 ID 可以强制重试。
- 音频：每四小时同步，校验完整性后替换；巡检同时检查任务和 HTTP 服务，恢复失败会通知。
- 调度与维护应在现有项目目录执行，任务计划、Caddyfile 引用的是该绝对路径。
- 2026-11-02 修复前的5个异常音频保留在 `.audio-repair-backups/2026-11-02/`，不进 Git、不被 Caddy 提供。

测试中的 Git、云存储、下载和任务计划均使用隔离替身，不会推送、写入真实 KV 或修改系统任务。真实 iOS 锁屏、系统回收与睡眠定时器仍需设备验证。
