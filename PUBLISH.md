# 发布与部署指南

## 开发环境

本地开发调试使用 `npm link`，将全局命令指向本地代码：

```bash
npm link
```

之后每次修改代码后只需运行：
```bash
npm run build
```
改动立即生效，无需重新安装。

取消 link：
```bash
npm unlink -g wechat-bridge-opencode
```

---

## 发布流程

### 1. 更新版本号

编辑 `package.json` 中的 `version` 字段：
```json
{
  "version": "0.1.6"
}
```

### 2. 发布到 npm

```bash
npm publish
```

### 3. 提交代码并推送 Tag

```bash
git add -A
git commit -m "release: v0.1.6"
git tag v0.1.6
git push origin main --tags
```

> **注意**：`git push` 的"同步"按钮**不会推送 tags**，必须单独执行 `git push origin --tags` 或 `git push origin v0.1.6`。

### 4. 自动创建 GitHub Release

推送 tag 后，GitHub Actions 会自动触发 `.github/workflows/release.yml`，自动创建带 Release Notes 的 GitHub Release。

---

## 完整命令示例

```bash
# 1. 改 package.json version 为 0.1.6

# 2. 发布 npm
npm publish

# 3. 提交并推送
git add -A
git commit -m "release: v0.1.6"
git tag v0.1.6
git push origin main --tags
```
