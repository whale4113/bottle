// Compatibility with services that still return Chinese status/error text.
// Document content and search answers keep their original language.
const serviceMessages: Record<string, string> = {
  等待同步: "Import queued",
  "尚未同步 GitHub Stars": "No GitHub documents imported yet",
  请先选择需要同步的仓库: "Select repositories to import first",
  "正在确认所选 GitHub Stars": "Checking selected repositories",
  正在写入所选仓库的本地索引: "Indexing selected repository documents",
  同步完成: "Import complete",
  同步失败: "Import failed",
  同步已取消: "Import canceled",
  同步已重置: "Imported data deleted",
  "服务已重启，请重新同步":
    "The service restarted. Please start the import again.",
  同步进程已中断: "The import was interrupted.",
  "当前账号未关联 GitHub 登录":
    "Connect a GitHub account to import starred repositories.",
  "GitHub 授权已失效，请重新登录 GitHub":
    "Your GitHub authorization has expired. Sign in with GitHub again.",
  "GitHub 请求受限，请检查授权或稍后重试":
    "GitHub has limited requests. Check your authorization or try again later.",
  "无法读取 GitHub Stars，请稍后重试":
    "Unable to load GitHub Stars. Please try again later.",
  请至少选择一个有效仓库: "Select at least one repository to import.",
  "已有同步任务进行中，请等待完成或取消后重试":
    "An import is running. Wait for it to finish or cancel it first.",
  "上次同步正在结束，请稍后重试":
    "The previous import is finishing. Please try again shortly.",
  "部分所选仓库已取消收藏或超出列表页数上限，请重新选择仓库":
    "Some selected repositories are no longer starred or are outside the loaded list. Review your selection.",
  仓库列表页码超出允许范围:
    "The requested repository page is outside the available range.",
  "GitHub 返回的仓库列表无效":
    "GitHub returned an invalid repository list. Please try again.",
  "GitHub HTTPS 证书校验失败，请检查系统证书和代理配置":
    "GitHub certificate verification failed. Check your system certificates and proxy configuration.",
  "连接 GitHub 失败，已尝试 4 次。请检查网络或 HTTPS 代理后重新同步":
    "Unable to connect to GitHub after 4 attempts. Check your network or HTTPS proxy and try again.",
};

export function englishMessage(
  value: unknown,
  fallback = "The request could not be completed. Please try again.",
): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  if (Object.hasOwn(serviceMessages, value)) return serviceMessages[value];
  const patterns: Array<[RegExp, (...parts: string[]) => string]> = [
    [
      /^正在下载或加载本地 embedding 模型 (.+)$/,
      (model) => `Preparing search model: ${model}`,
    ],
    [
      /^正在读取 (.+) 的 README$/,
      (repository) => `Fetching README: ${repository}`,
    ],
    [
      /^(.+)：正在生成向量 (\d+)\/(\d+)$/,
      (repository, current, total) =>
        `Indexing ${repository}: passage ${current}/${total}`,
    ],
    [
      /^(.+)：正在写入 (\d+) 个分块$/,
      (repository, count) => `Saving ${count} passages for ${repository}`,
    ],
    [
      /^已找到 (\d+)\/(\d+) 个所选仓库$/,
      (current, total) => `Found ${current}/${total} selected repositories`,
    ],
    [
      /^已同步 (\d+)\/(\d+) 个仓库$/,
      (current, total) => `Imported ${current}/${total} repositories`,
    ],
    [
      /^已拉取 (\d+) 个 Stars，达到页数上限 (\d+)$/,
      (count) =>
        `Fetched ${count} starred repositories. The list limit has been reached.`,
    ],
  ];
  for (const [pattern, format] of patterns) {
    const match = value.match(pattern);
    if (match) return format(...match.slice(1));
  }
  return /\p{Script=Han}/u.test(value) ? fallback : value;
}
