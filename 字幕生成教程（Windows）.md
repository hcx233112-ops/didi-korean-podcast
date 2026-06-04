# 字幕生成教程（Windows）

在家里 Windows 电脑上运行，YouTube 不会封家庭 IP。

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
pip install youtube-transcript-api deep-translator
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

脚本会自动跳过已有字幕的视频，大约跑 20–30 分钟。

### 第四步：推回 GitHub
```powershell
git add public\data\transcripts\
git commit -m "chore: add transcripts"
git push
```

第一次 push 会弹出 GitHub 登录窗口，用浏览器授权即可。

推送后 Vercel 自动部署，网站字幕立即更新。

---

## 需要哪些文件

克隆仓库后已包含所有必要文件：

| 文件 | 用途 |
|------|------|
| `scripts/generate-transcripts.py` | 生成脚本 |
| `public/data/videos/didi.json` | 视频列表（脚本读取此文件） |
| `public/data/transcripts/` | 字幕输出目录（自动创建） |

不需要额外准备任何东西。
