#!/usr/bin/env python3
"""开机自启：无窗口启动 Caddy 文件服务器 + cloudflared 隧道，供音频服务使用。"""
import os, subprocess, sys

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NO_WINDOW = 0x08000000


def already_running(name):
    r = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {name}"],
                       capture_output=True, text=True)
    return name.lower() in r.stdout.lower()


if not already_running("caddy.exe"):
    subprocess.Popen([os.path.join(ROOT, "caddy.exe"), "run", "--config",
                      os.path.join(ROOT, "Caddyfile")],
                     cwd=ROOT, creationflags=NO_WINDOW)
if not already_running("cloudflared.exe"):
    subprocess.Popen([os.path.join(ROOT, "cloudflared.exe"), "tunnel", "run"],
                     cwd=ROOT, creationflags=NO_WINDOW)
