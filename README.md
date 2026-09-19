# Xdownloader

macOS 上的 aria2 桌面客户端。多连接分块可视化、YouTube 清晰度与音画合成。正式 DMG 已内置 `aria2c`、`yt-dlp`、`ffmpeg` / `ffprobe`，并经 Apple 公证。

官网：<https://bennix.github.io/Xdownloader/>  
发布：<https://github.com/bennix/Xdownloader/releases>

## 开发

```bash
npm install
npm run prepare:bins
npm run dev
```

## 打包公证 DMG

需要本机已安装 `Developer ID Application: ZHIPING XU`。公证密码用环境变量，不要写进仓库：

```bash
export APPLE_ID='your-apple-id'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='5N66S29EK2'
npm run dist
```

产物在 `release/Xdownloader-1.0.0-arm64.dmg`。
