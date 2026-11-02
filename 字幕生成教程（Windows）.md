# 字幕生成教程（Windows）

在 Windows 本机生成韩语和中文字幕。下载和翻译受源站可用性及限流影响，失败会返回非零状态并保留可重试数据。

---

## 一次性准备（只需做一次）

### 1. 装 Python
去 [python.org](https://www.python.org/downloads/) 下载安装。
安装时勾选 **"Add Python to PATH"**（重要）。

### 2. 装 Git
去 [git-scm.com](https://git-scm.com/download/win) 下载安装，一路默认。

### 3. 克隆仓库
打开 PowerShell，运行：
```powershell
git clone https://github.com/hcx233112-ops/didi-korean-podcast.git
cd didi-korean-podcast
```

### 4. 装依赖
```powershell
python -m pip install -r scripts/requirements-automation.txt
```

---

## 每次生成字幕

### 第一步：进入项目目录
```powershell
cd didi-korean-podcast
```

### 第二步：拉取最新视频列表
```powershell
git pull
```

### 第三步：跑脚本
```powershell
python scripts\generate-transcripts.py
```

脚本跳过有效字幕，无字幕结果七天后复查；指定视频 ID 可强制复查。首次生成耗时取决于字幕数量和网络。生成不再自行推送或删除本地文件。

```powershell
python scripts\generate-transcripts.py VIDEO_ID
python scripts\retranslate.py
```

日常自动运行请使用 `scripts\run-transcripts.py`，由它持有仓库互斥锁并调用完整流程。手动生成完成后，可自行审核数据差异再提交。

### 第四步：推回 GitHub
```powershell
git add public\data\transcripts\
git commit -m "chore: add transcripts"
git push
```

第一次 push 会弹出 GitHub 登录窗口，用浏览器授权即可。

推送会触发已配置的 Vercel 部署；部署完成后字幕可供网页读取。

---

## 需要哪些文件

克隆仓库后已包含所有必要文件：

| 文件 | 用途 |
|------|------|
| `scripts/generate-transcripts.py` | 生成脚本 |
| `public/data/videos/didi.json` | 视频列表（脚本读取此文件） |
| `public/data/transcripts/` | 字幕输出目录（自动创建） |

不需要额外准备任何东西。
