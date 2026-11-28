@AGENTS.md

## 上线
- 改完后 `npm test`、`npm run build`、`npx playwright test` 全部通过，就直接合并到 main 上线（Vercel 自动部署），不用再问用户；上线后确认部署成功，并告诉用户改了什么。测试没过不上线。（2026-11-28 用户："自动上线就行，不用每次要求"）
- 代码在 worktree `E:\claude\podcast-dev` 改，不要动生产目录 `E:\claude\播客`：那里的计划任务每小时 git pull、每天推送字幕。
