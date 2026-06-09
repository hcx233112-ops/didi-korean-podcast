# 音频托管部署（Windows + Cloudflare Tunnel）

把 Windows 上下好的 m4a 通过域名对外提供，前端（Vercel）用原生 `<audio>` 播放，
实现 iOS 息屏后台播放 + 锁屏拖进度条。

整条链路：

```
iPhone → audio.yanxuan-kr.cn (Cloudflare) → Tunnel → Windows 本机 :8080 (Caddy) → audio/*.m4a
前端(Vercel) 的 <audio src> = https://audio.yanxuan-kr.cn/{videoId}.m4a
```

> 域名：`yanxuan-kr.cn`，音频子域名：`audio.yanxuan-kr.cn`。

---

## 前提

- 音频已经下到 `podcast-player\audio\*.m4a`（`scripts\extract-audio.bat` 跑完）
- 文件名就是 YouTube 视频 ID，例如 `Rklp86IDOPc.m4a`，前端按这个规则取

---

## 第一步：Caddy 静态服务器（必须支持 Range）

> 为什么用 Caddy：iOS 播放/拖进度条依赖 HTTP Range（返回 206）。
> Python 自带的 `http.server` 不支持 Range，会导致无法拖动甚至无法播放。

1. 下载 `caddy.exe`：https://caddyserver.com/download （Windows amd64），放到 `podcast-player\` 下
2. 在 `podcast-player\` 新建文件 `Caddyfile`，内容：

```
:8080 {
	root * C:/Users/你的用户名/Documents/claude/播客/podcast-player/audio
	file_server browse
	header Access-Control-Allow-Origin *
}
```

3. 在该目录打开 PowerShell，运行：

```powershell
.\caddy.exe run
```

4. 本机验证（应能下载/播放，且带 Range）：

```powershell
# 浏览器打开 http://localhost:8080/ 能看到文件列表
# 验证 Range：期望返回 206 和 Accept-Ranges: bytes
curl.exe -I -H "Range: bytes=0-100" http://localhost:8080/某个视频ID.m4a
```

看到 `HTTP/1.1 206 Partial Content` 就对了。

---

## 第二步：Cloudflare Tunnel（自动建 DNS，不用手动加记录）

用 Zero Trust 面板的「远程管理隧道」，最省心：

1. 进 Cloudflare → 左侧 **Zero Trust** → **Networks → Tunnels** → **Create a tunnel**
2. 选 **Cloudflared** → 起个名字（如 `podcast-audio`）→ Next
3. 平台选 **Windows**，它给一条带 token 的命令，在 Windows 管理员 PowerShell 里运行（会把 cloudflared 装成开机自启服务）：

```powershell
# 形如（直接复制面板给你的那条，别用这行）：
cloudflared.exe service install eyJhxxxx...
```

4. 回面板，配 **Public Hostname**：
   - Subdomain：`audio`
   - Domain：`yanxuan-kr.cn`
   - Type：`HTTP`
   - URL：`localhost:8080`
5. 保存。Cloudflare 会自动给 `audio.yanxuan-kr.cn` 建一条 CNAME（指向 `xxx.cfargotunnel.com`）。
   **DNS 这步到此就完成了，不用自己去 DNS 里加东西。**

验证（用你的 Mac 或手机都行）：

```bash
curl -I -H "Range: bytes=0-100" https://audio.yanxuan-kr.cn/某个视频ID.m4a
# 期望：HTTP/2 206 + accept-ranges: bytes
```

> SSL：Cloudflare 边缘自动签 HTTPS 证书；隧道到本机是加密的，本机用 HTTP localhost 没问题，不用在 SSL 设置里折腾。

---

## 第三步：前端连上（Vercel 环境变量）

前端已改成读环境变量 `NEXT_PUBLIC_AUDIO_BASE`（见 `app/page.tsx`）。

1. Vercel → 项目 → **Settings → Environment Variables**
2. 新增：
   - Name：`NEXT_PUBLIC_AUDIO_BASE`
   - Value：`https://audio.yanxuan-kr.cn/`   ← 注意结尾带 `/`
   - 环境：Production（顺便 Preview 也勾上）
3. **重新部署**（`NEXT_PUBLIC_` 变量在构建时写死，改完必须 redeploy 才生效）

本地开发不设这个变量时，会回落到 `/audio/`，可把音频放 `public/audio/` 临时测试。

---

## 验证清单

- [ ] `http://localhost:8080/xxx.m4a` 本机能放，Range 返回 206
- [ ] `https://audio.yanxuan-kr.cn/xxx.m4a` 外网能放，Range 返回 206
- [ ] Vercel 站点点一集，能播；iPhone Safari 锁屏后继续播、锁屏有封面和控制条、能拖进度条

---

## 自动更新（博主发新视频后全自动）

已经自动的部分（GitHub Actions，不用管）：

- `update-videos.yml`：每 4 小时抓频道新视频 → 更新视频列表 → push
- `generate-transcripts.yml`：每天凌晨 2 点给新视频生成字幕 → push
- push 后 Vercel 自动重新部署前端

唯一要在 Windows 上补的：**新视频的音频自动增量下载**。脚本已备好 `scripts\update-audio.bat`，
它会先 `git pull` 拿到 CI 抓好的最新列表，再跑 `extract-audio.py` 把新音频下下来（已有的跳过）。

挂 Windows 任务计划，每天跑一次（放在 CI 抓视频/字幕之后，比如凌晨 3 点）。
管理员 PowerShell 跑一次（把路径换成你的实际路径）：

```powershell
schtasks /create /tn "podcast-audio-update" /sc daily /st 03:00 ^
  /tr "C:\Users\你的用户名\Documents\claude\播客\podcast-player\scripts\update-audio.bat"
```

之后博主更新 → 几小时内列表/字幕自动上线，凌晨 3 点 Windows 自动把新音频补齐，全程不用动手。
（前提：Caddy 和 cloudflared 都设成了开机自启，机器开着。）

---

## 常见问题

- **锁屏不显示控制条**：确认是用域名上的站点（不是本地 dev），且这一集确实在播原生音频（不是旧的 YouTube）。`mediaSession` 已在代码里接好。
- **能播但拖不动进度**：八成是服务器没回 Range（206）。别用 Python http.server，用 Caddy。
- **跨域报错**：Caddyfile 里已加 `Access-Control-Allow-Origin *`；原生 `<audio>` 跨域播放本身不需要 CORS，一般不会报。
- **Windows 重启后断了**：cloudflared 装成了服务会自启；Caddy 要自启的话可以用 `nssm` 或任务计划把 `caddy run` 设为开机运行。
- **大文件/流量**：个人自用没问题；Cloudflare 免费版对大量媒体走 CDN 缓存有限制，但隧道是回源到你本机，自用流量不大无需处理。
