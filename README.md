# ChatGPT / Claude 本地导出器

[简体中文](README.md) | [English](README.en.md)

一个小型浏览器扩展，用于将你的 ChatGPT 或 Claude 对话下载为本地 ZIP
归档。

扩展完全在浏览器中运行,纯粹的本地浏览器脚本。使用当前网站已有的登录会话。

## 功能

- 导出全部对话。
- 仅导出自上次成功导出后发生变化的对话。
- 保留 ChatGPT Project 的路径和元数据。
- 同时导出服务商返回的 JSON 和便于阅读的 Markdown。
- 服务商返回 HTTP 429 时立即停止。
- 将增量导出状态保存在当前浏览器配置中。

## 在 Chrome 中安装

1. 在release里下载压缩包。
2. 打开 `chrome://extensions/`。
3. 启用右上角的**开发者模式**。
4. 点击**加载已解压的扩展程序**。
5. 选择本仓库所在目录。
6. 打开 [ChatGPT](https://chatgpt.com/) 或 [Claude](https://claude.ai/)。

页面右下角会出现导出面板。

## 使用

- **Export updated**：列出账号中的对话，只下载列表元数据自上次成功
  导出后发生变化的对话。
- **Export all**：下载网站返回的全部对话。
- **Reset state**：清除已经保存的增量指纹和失败计数。
- **Stop**：当前请求完成后停止。

下载的 ZIP 包含：

```text
manifest.json
conversations/<path>/<conversation-id>.json
markdown/<path>/<conversation-title>-<short-id>.md
```

归档中可能包含私人对话、元数据、文件引用，以及服务商返回的其他信息。

## 作为用户脚本安装

同一份源码也可以在 Tampermonkey 等用户脚本管理器中运行：

```text
chatgpt-local-exporter.user.js
```

## 开发

仓库中提交的源码就是浏览器实际运行的源码。

基本语法检查：

```bash
node --check chatgpt-local-exporter.user.js
```

本扩展依赖网站当前的内部响应格式；
网站更新后，导出器可能也需要相应更新。


## 许可证

GPL-3.0
