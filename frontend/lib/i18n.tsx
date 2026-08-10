"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Language = "zh" | "en";

const messages = {
  zh: {
    "nav.agents": "智能体",
    "nav.workspace": "工作区",
    "nav.analysis": "Analysis",
    "nav.tasks": "任务执行中心",
    "nav.traits": "Image Judge",
    "nav.downloads": "下载最新应用程序",
    "downloads.title": "下载最新应用程序",
    "downloads.heading": "Infinity Agents 应用程序",
    "downloads.description": "从这里进入官方发布页，下载已经发布并可校验的桌面应用程序。当前页面不会把浏览器示例页当作安装程序。",
    "downloads.windowsTitle": "Windows",
    "downloads.windowsDescription": "发布页提供当前可用的 Windows 安装包或便携包。",
    "downloads.linuxTitle": "Linux",
    "downloads.linuxDescription": "发布页提供当前可用的 Linux 安装包；请按资产名称和校验信息选择。",
    "downloads.macTitle": "macOS",
    "downloads.macDescription": "macOS 原生安装包尚未完成签名和公证，暂不显示不可验证的下载链接。",
    "downloads.openReleases": "打开官方发布页",
    "downloads.releaseNoteTitle": "下载说明",
    "downloads.releaseNote": "发布页是安装包和版本校验信息的来源。后续接入稳定 manifest 后，这里会自动显示对应系统的直接下载按钮。",
    "nav.paper": "Analysis",
    "nav.code": "CodeAgent",
    "nav.imageJudge": "ImageJudge",
    "workspace.openMenu": "打开工作区菜单",
    "workspace.closeMenu": "关闭工作区菜单",
    "home.newChat": "新对话",
    "home.recentActivities": "最近对话",
    "home.paperAgent": "Analysis",
    "home.signInRegister": "登录 / 注册",
    "auth.signInTitle": "登录后使用 Analysis",
    "auth.signInDescription": "登录后即可保存对话，并使用论文检索和阅读工具。",
    "auth.signIn": "登录 / 注册",
    "auth.logout": "退出登录",
    "auth.loggingOut": "退出中…",
    "auth.logoutFailed": "退出登录失败，请重试",
    "auth.accountFallback": "账户",
    "home.emptyTitle": "今天想让我帮你做什么？",
    "role.you": "你",
    "role.assistant": "助手",
    "composer.signInPlaceholder": "登录后开始对话…",
    "composer.messagePlaceholder": "发送给 Analysis…",
    "composer.retry": "重试",
    "composer.dismiss": "关闭",
    "composer.disclaimer": "AI 可能出错，请核查重要信息。",
    "session.noActivities": "暂无对话",
    "session.untitled": "未命名对话",
    "session.confirm": "确认",
    "session.cancel": "取消",
    "session.edit": "编辑对话标题",
    "session.delete": "删除对话",
    "session.confirmDelete": "确认删除对话",
    "session.cancelDelete": "取消删除对话",
    "run.running": "运行中：{{tool}}",
    "run.retrying": "重试中（{{reason}}）{{attempt}}",
    "run.generating": "生成回答（{{seconds}} 秒）{{attempt}}",
    "run.thinking": "思考中（{{seconds}} 秒）{{attempt}}{{suffix}}",
    "run.firstChunkTimeout": "首段响应超时",
    "run.processing": "处理中",
    "run.toolTriggered": " · 工具已触发",
    "run.tool": "工具",
    "error.backendUnavailable": "后端服务不可用",
    "error.loadSessions": "加载对话失败：{{message}}",
    "error.loadSessionsToast": "加载对话失败，请确认服务正在运行。",
    "error.loadMessages": "加载消息失败：{{message}}",
    "error.loadMessagesToast": "加载消息失败，请重试。",
    "error.createSession": "创建对话失败，请重试。",
    "error.loadHistory": "发送前加载对话历史失败，请重试。",
    "error.updateTitle": "更新对话标题失败。",
    "error.runningDelete": "对话仍在运行，请先停止后再删除。",
    "error.runningWait": "对话仍在运行，请等待或先停止。",
    "error.deleteSession": "删除对话失败。",
    "error.network": "网络连接失败",
    "error.networkToast": "网络连接失败。",
    "error.connection": "连接错误",
    "error.paperUnavailable": "当前对话无法访问这篇论文。请先搜索它，再读取全文。",
    "upload.onlyPdf": "只支持 PDF 文件。",
    "upload.createSession": "创建对话失败，无法上传论文。",
    "upload.success": "已上传：{{filename}}",
    "upload.failed": "上传失败：{{message}}",
    "upload.unknown": "未知错误",
    "upload.message": "已上传论文 **{{filename}}**。\n参考：`uploaded://{{paperId}}`。现在可以让 Analysis 根据它生成阅读指南。",
    "upload.unsupported": "当前版本暂不支持 PDF 上传。",
    "error.pageTitle": "页面加载失败",
    "error.pageDescription": "应用遇到错误，请重试或刷新页面。",
    "error.retry": "重试",
    "error.reload": "刷新",
    "image.examplesTitle": "文件分析示例",
    "image.examplesBadge": "文件分析示例",
    "image.compatibilityMode": "兼容分类模式",
    "image.referenceImages": "参考图片",
    "image.referenceImagesHint": "先查看用于定义规则的参考图。",
    "image.uploadedImages": "上传图片",
    "image.uploadedImagesHint": "下面展示本示例中的待分析图片。",
    "image.analysisDescription": "图片介绍",
    "image.analysisRule": "判定规则",
    "image.judgmentCategories": "判定类别",
    "image.reviewHint": "结果只展示有图像依据的判断；不确定内容进入人工复核。",
    "image.resultPass": "通过",
    "image.resultReview": "待人工复核",
    "image.resultFailed": "未通过",
    "tasks.title": "任务",
    "tasks.subtitle": "管理并追踪分析任务",
    "tasks.management": "任务管理",
    "tasks.refresh": "刷新",
    "tasks.newTask": "新建任务",
    "tasks.noTasksYet": "暂时无任务",
    "tasks.discardDraft": "当前任务还没有保存，确定要放弃吗？",
    "tasks.empty": "暂无任务",
    "tasks.emptyDescription": "创建 TaskSpec 并提交任务后，它们将显示在这里。",
    "tasks.id": "ID",
    "tasks.titleColumn": "标题",
    "tasks.status": "状态",
    "tasks.attempts": "尝试",
    "tasks.createdAt": "创建时间",
    "tasks.actions": "操作",
    "tasks.view": "查看",
    "tasks.cancel": "取消",
    "tasks.noArtifacts": "暂无产物",
    "tasks.noEvents": "暂无事件",
    "tasks.detailBack": "返回任务列表",
    "tasks.detailTitle": "任务详情",
    "tasks.detailStatus": "状态",
    "tasks.detailAttempts": "已尝试次数",
    "tasks.detailMaxAttempts": "最大尝试次数",
    "tasks.detailCreatedAt": "创建时间",
    "tasks.detailFinishedAt": "完成时间",
    "tasks.detailError": "错误信息",
    "tasks.detailArtifacts": "产物",
    "tasks.detailArtifactsHint": "任务完成后，可从这里下载已验证的结果文件。",
    "tasks.downloadArtifact": "下载结果",
    "tasks.detailEvents": "事件日志",
    "tasks.detailLiveEvents": "实时事件",
    "tasks.detailNoArtifacts": "此任务尚无可用产物。",
    "tasks.detailNoEvents": "此任务尚无事件日志。",
    "tasks.statusDraft": "草稿",
    "tasks.statusQueued": "排队中",
    "tasks.statusClaimed": "已认领",
    "tasks.statusRunning": "运行中",
    "tasks.statusSucceeded": "成功",
    "tasks.statusFailed": "失败",
    "tasks.statusCancelled": "已取消",
    "tasks.statusTimeout": "超时",
    "tasks.cancelConfirm": "确定要取消这个任务吗？",
    "tasks.cancelSuccess": "任务已取消。",
    "tasks.cancelFailed": "取消失败：{{message}}",
    "tasks.loadFailed": "加载任务失败：{{message}}",
    "tasks.loadFailedToast": "加载任务失败，请重试。",
    "tasks.listFailed": "加载任务列表失败：{{message}}",
    "tasks.listFailedToast": "加载任务列表失败，请重试。",
    "tasks.cancelFailedToast": "取消失败，请重试。",
    "tasks.newTaskDescription": "上传一份执行文档（HTML / PDF 等流程说明）和一个 ZIP 数据集，即可创建并提交分析任务。",
    "tasks.methodDoc": "执行文档",
    "tasks.methodDocHint": "描述分析流程的网页 / PDF / Markdown 等",
    "tasks.dataset": "数据集",
    "tasks.datasetHint": "待分析的数据文件（.zip）",
    "tasks.taskTitlePlaceholder": "任务标题（默认使用执行文档名称）",
    "tasks.create": "创建任务",
    "tasks.creating": "创建中…",
    "tasks.requireBoth": "请先选择执行文档和数据集。",
    "tasks.createSuccess": "任务已创建并提交执行。",
    "tasks.createFailed": "创建失败：{{message}}",
    "tasks.confirmationTitle": "确认并提交分析任务",
    "tasks.confirmationDescription": "在 Analysis 中检查执行文档和数据集后，明确确认才会冻结输入并创建一个异步 Task。",
    "tasks.confirmAndSubmit": "确认并提交",
    "tasks.confirmationOnlyTitle": "任务只能从 Analysis 确认卡提交",
    "tasks.confirmationOnlyDescription": "这里用于查看历史 Task、Attempt、状态和结果。请回到 Analysis 完成材料检查与用户确认。",
    "tasks.createCardTitle": "创建任务",
    "tasks.createCardDescription": "选择执行文档和 ZIP 数据集后，直接创建一个异步任务并加入队列。",
    "tasks.enrollmentTitle": "添加 Worker",
    "tasks.enrollmentDescription": "为当前账户创建一个可长期使用的 Worker。Namespace 可以复用，同一范围可以添加多台机器。",
    "tasks.enrollmentWorkerId": "Worker ID",
    "tasks.enrollmentNamespace": "命名空间",
    "tasks.enrollmentTrustLevel": "服务端信任级别",
    "tasks.enrollmentTrustOwner": "所有者可信",
    "tasks.enrollmentTrustInstitution": "机构一般信任",
    "tasks.enrollmentTrustStudent": "机构一般信任",
    "tasks.enrollmentIssue": "添加 Worker",
    "tasks.enrollmentIssuing": "签发中…",
    "tasks.enrollmentServerGuard": "信任级别由登录权限自动生成，凭证不会过期。",
    "tasks.enrollmentIssued": "Worker 已创建",
    "tasks.enrollmentTokenHint": "请把这个持久凭证保存到目标机器的本地 Worker 配置中；数据库保存加密凭证和校验摘要。",
    "tasks.enrollmentTokenLabel": "持久 Worker 凭证",
    "tasks.enrollmentCopy": "复制",
    "tasks.enrollmentCopied": "已复制",
    "tasks.enrollmentCopySaved": "复制持久凭证",
    "tasks.enrollmentRotate": "重新生成并复制",
    "tasks.enrollmentCredentialFailed": "持久凭证读取失败",
    "tasks.enrollmentFailed": "签发失败",
    "tasks.enrollmentExisting": "已保存的 Workers",
    "tasks.enrollmentNoExisting": "当前还没有已保存的 Worker。",
    "tasks.enrollmentPresenceOnline": "在线",
    "tasks.enrollmentPresenceOffline": "离线（登记保留）",
    "tasks.enrollmentPresenceNeverSeen": "尚未连接",
    "tasks.enrollmentStatusActive": "已登记",
    "tasks.enrollmentStatusDraining": "停止接收新任务",
    "tasks.enrollmentStatusRevoked": "已撤销",
  },
  en: {
    "nav.agents": "Agents",
    "nav.workspace": "Workspace",
    "nav.analysis": "Analysis",
    "nav.tasks": "Task Center",
    "nav.traits": "Image Judge",
    "nav.downloads": "Download latest app",
    "downloads.title": "Download latest app",
    "downloads.heading": "Infinity Agents applications",
    "downloads.description": "Open the official release page to download desktop applications that have actually been published and can be verified. This page is separate from the browser examples.",
    "downloads.windowsTitle": "Windows",
    "downloads.windowsDescription": "The release page contains the currently available Windows installer or portable package.",
    "downloads.linuxTitle": "Linux",
    "downloads.linuxDescription": "The release page contains the currently available Linux package; choose it by asset name and checksum.",
    "downloads.macTitle": "macOS",
    "downloads.macDescription": "A signed and notarized native macOS package is not ready yet, so no unverifiable download link is shown.",
    "downloads.openReleases": "Open official releases",
    "downloads.releaseNoteTitle": "Download note",
    "downloads.releaseNote": "The release page is the source for packages and version checks. Once the stable manifest is connected, this page will show a direct download button for the detected platform.",
    "nav.paper": "Analysis",
    "nav.code": "CodeAgent",
    "nav.imageJudge": "ImageJudge",
    "workspace.openMenu": "Open workspace menu",
    "workspace.closeMenu": "Close workspace menu",
    "home.newChat": "New chat",
    "home.recentActivities": "Recent conversations",
    "home.paperAgent": "Analysis",
    "home.signInRegister": "Sign in / Register",
    "auth.signInTitle": "Sign in to use Analysis",
    "auth.signInDescription": "Sign in to save conversations and use paper search and reading tools.",
    "auth.signIn": "Sign in / Register",
    "auth.logout": "Log out",
    "auth.loggingOut": "Logging out…",
    "auth.logoutFailed": "Log out failed. Please try again.",
    "auth.accountFallback": "Account",
    "home.emptyTitle": "How can I help you today?",
    "role.you": "You",
    "role.assistant": "Assistant",
    "composer.signInPlaceholder": "Sign in to start a conversation…",
    "composer.messagePlaceholder": "Message Analysis…",
    "composer.retry": "Retry",
    "composer.dismiss": "Dismiss",
    "composer.disclaimer": "AI can make mistakes. Check important info.",
    "session.noActivities": "No conversations yet",
    "session.untitled": "Untitled conversation",
    "session.confirm": "Confirm",
    "session.cancel": "Cancel",
    "session.edit": "Edit conversation title",
    "session.delete": "Delete conversation",
    "session.confirmDelete": "Confirm delete conversation",
    "session.cancelDelete": "Cancel delete conversation",
    "run.running": "Running: {{tool}}",
    "run.retrying": "Retrying ({{reason}}){{attempt}}",
    "run.generating": "Generating response ({{seconds}}s){{attempt}}",
    "run.thinking": "Thinking ({{seconds}}s){{attempt}}{{suffix}}",
    "run.firstChunkTimeout": "first chunk timeout",
    "run.processing": "processing",
    "run.toolTriggered": " · tool triggered",
    "run.tool": "tool",
    "error.backendUnavailable": "Backend service is unavailable",
    "error.loadSessions": "Failed to load sessions: {{message}}",
    "error.loadSessionsToast": "Failed to load sessions. Check that the backend is running.",
    "error.loadMessages": "Failed to load messages: {{message}}",
    "error.loadMessagesToast": "Failed to load messages. Try again.",
    "error.createSession": "Failed to create a session. Try again.",
    "error.loadHistory": "Failed to load conversation history. Try again.",
    "error.updateTitle": "Failed to update the conversation title.",
    "error.runningDelete": "This conversation is still running. Stop it before deleting.",
    "error.runningWait": "This conversation is still running. Wait or stop it first.",
    "error.deleteSession": "Failed to delete the conversation.",
    "error.network": "Network connection failed",
    "error.networkToast": "Network connection failed.",
    "error.connection": "Connection error",
    "error.paperUnavailable": "This paper is not available in the current session. Search for it first, then read it.",
    "upload.onlyPdf": "Only PDF files are supported.",
    "upload.createSession": "Failed to create a session, so the paper cannot be uploaded.",
    "upload.success": "Uploaded: {{filename}}",
    "upload.failed": "Upload failed: {{message}}",
    "upload.unknown": "Unknown error",
    "upload.message": "Uploaded paper **{{filename}}**.\nReference: `uploaded://{{paperId}}`. You can now ask Analysis to create a guide from it.",
    "upload.unsupported": "PDF upload is not available in this version.",
    "error.pageTitle": "Page failed to load",
    "error.pageDescription": "The application encountered an error. Try again or refresh the page.",
    "error.retry": "Retry",
    "error.reload": "Reload",
    "image.examplesTitle": "File analysis examples",
    "image.examplesBadge": "File analysis example",
    "image.compatibilityMode": "Compatibility classification mode",
    "image.referenceImages": "Reference images",
    "image.referenceImagesHint": "Start with the reference image that defines the rule.",
    "image.uploadedImages": "Uploaded images",
    "image.uploadedImagesHint": "The target images for this example appear below.",
    "image.analysisDescription": "Image description",
    "image.analysisRule": "Judgment rule",
    "image.judgmentCategories": "Judgment categories",
    "image.reviewHint": "Only image-supported judgments are shown; uncertain cases go to human review.",
    "image.resultPass": "PASS",
    "image.resultReview": "REVIEW",
    "image.resultFailed": "FAILED",
    "tasks.title": "Tasks",
    "tasks.subtitle": "Manage and track analysis tasks",
    "tasks.management": "Task management",
    "tasks.refresh": "Refresh",
    "tasks.newTask": "New task",
    "tasks.noTasksYet": "No tasks yet",
    "tasks.discardDraft": "Discard the current unsaved task draft?",
    "tasks.empty": "No tasks yet",
    "tasks.emptyDescription": "Create a TaskSpec and submit a task to see it here.",
    "tasks.id": "ID",
    "tasks.titleColumn": "Title",
    "tasks.status": "Status",
    "tasks.attempts": "Attempts",
    "tasks.createdAt": "Created",
    "tasks.actions": "Actions",
    "tasks.view": "View",
    "tasks.cancel": "Cancel",
    "tasks.noArtifacts": "No artifacts yet",
    "tasks.noEvents": "No events yet",
    "tasks.detailBack": "Back to tasks",
    "tasks.detailTitle": "Task detail",
    "tasks.detailStatus": "Status",
    "tasks.detailAttempts": "Attempts",
    "tasks.detailMaxAttempts": "Max attempts",
    "tasks.detailCreatedAt": "Created at",
    "tasks.detailFinishedAt": "Finished at",
    "tasks.detailError": "Error",
    "tasks.detailArtifacts": "Artifacts",
    "tasks.detailArtifactsHint": "Download verified result files after the task completes.",
    "tasks.downloadArtifact": "Download result",
    "tasks.detailEvents": "Event log",
    "tasks.detailLiveEvents": "Live events",
    "tasks.detailNoArtifacts": "This task has no artifacts yet.",
    "tasks.detailNoEvents": "This task has no events yet.",
    "tasks.statusDraft": "Draft",
    "tasks.statusQueued": "Queued",
    "tasks.statusClaimed": "Claimed",
    "tasks.statusRunning": "Running",
    "tasks.statusSucceeded": "Succeeded",
    "tasks.statusFailed": "Failed",
    "tasks.statusCancelled": "Cancelled",
    "tasks.statusTimeout": "Timeout",
    "tasks.cancelConfirm": "Are you sure you want to cancel this task?",
    "tasks.cancelSuccess": "Task cancelled.",
    "tasks.cancelFailed": "Cancel failed: {{message}}",
    "tasks.loadFailed": "Failed to load task: {{message}}",
    "tasks.loadFailedToast": "Failed to load task. Try again.",
    "tasks.listFailed": "Failed to load task list: {{message}}",
    "tasks.listFailedToast": "Failed to load task list. Try again.",
    "tasks.cancelFailedToast": "Failed to cancel task. Try again.",
    "tasks.newTaskDescription": "Upload an execution document (HTML / PDF workflow instructions) and a ZIP dataset to create and queue an analysis task.",
    "tasks.methodDoc": "Execution Document",
    "tasks.methodDocHint": "A saved web page / PDF / Markdown describing the workflow",
    "tasks.dataset": "Dataset",
    "tasks.datasetHint": "Data to analyze (.zip)",
    "tasks.taskTitlePlaceholder": "Task title (defaults to the execution document name)",
    "tasks.create": "Create Task",
    "tasks.creating": "Creating…",
    "tasks.requireBoth": "Please select both an execution document and a dataset.",
    "tasks.createSuccess": "Task created and queued for execution.",
    "tasks.createFailed": "Failed to create task: {{message}}",
    "tasks.confirmationTitle": "Confirm and submit analysis task",
    "tasks.confirmationDescription": "Review the method document and dataset in Analysis. An explicit confirmation freezes the inputs and creates one asynchronous Task.",
    "tasks.confirmAndSubmit": "Confirm and submit",
    "tasks.confirmationOnlyTitle": "Tasks are submitted from the Analysis confirmation card",
    "tasks.confirmationOnlyDescription": "This page is for history, Attempts, status, and results. Return to Analysis to review inputs and confirm submission.",
    "tasks.createCardTitle": "Create task",
    "tasks.createCardDescription": "Choose an execution document and ZIP dataset to create an asynchronous task directly in the queue.",
    "tasks.enrollmentTitle": "Add Worker",
    "tasks.enrollmentDescription": "Create a long-lived Worker for this account. A Namespace can be reused by multiple machines.",
    "tasks.enrollmentWorkerId": "Worker ID",
    "tasks.enrollmentNamespace": "Namespace",
    "tasks.enrollmentTrustLevel": "Server-assigned trust level",
    "tasks.enrollmentTrustOwner": "Owner trusted",
    "tasks.enrollmentTrustInstitution": "Institution trust",
    "tasks.enrollmentTrustStudent": "Institution trust",
    "tasks.enrollmentIssue": "Add Worker",
    "tasks.enrollmentIssuing": "Issuing…",
    "tasks.enrollmentServerGuard": "Trust is generated from login permissions; the credential does not expire.",
    "tasks.enrollmentIssued": "Worker created",
    "tasks.enrollmentTokenHint": "Save this persistent credential in the local Worker configuration; the database keeps an encrypted copy and its verification digest.",
    "tasks.enrollmentTokenLabel": "Persistent Worker credential",
    "tasks.enrollmentCopy": "Copy",
    "tasks.enrollmentCopied": "Copied",
    "tasks.enrollmentCopySaved": "Copy persistent credential",
    "tasks.enrollmentRotate": "Regenerate and copy",
    "tasks.enrollmentCredentialFailed": "Could not read persistent credential",
    "tasks.enrollmentFailed": "Issue failed",
    "tasks.enrollmentExisting": "Saved Workers",
    "tasks.enrollmentNoExisting": "No saved Workers yet.",
    "tasks.enrollmentPresenceOnline": "Online",
    "tasks.enrollmentPresenceOffline": "Offline (registration kept)",
    "tasks.enrollmentPresenceNeverSeen": "Not connected yet",
    "tasks.enrollmentStatusActive": "Registered",
    "tasks.enrollmentStatusDraining": "Draining",
    "tasks.enrollmentStatusRevoked": "Revoked",
  },
} as const;

export type TranslationKey = keyof typeof messages.en;
type TranslationValues = Record<string, string | number>;

function interpolate(template: string, values?: TranslationValues): string {
  if (!values) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ""));
}

export function translate(language: Language, key: TranslationKey, values?: TranslationValues): string {
  const template = messages[language][key] ?? messages.en[key];
  return interpolate(template, values);
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);
const LOCALE_CACHE_KEY = "infinity-agents-locale-cache";

function isLanguage(value: string | null): value is Language {
  return value === "zh" || value === "en";
}

function detectSystemLanguage(): Language {
  if (typeof navigator === "undefined") return "zh";
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((value) => /^zh(?:[-_,]|$)/i.test(value)) ? "zh" : "en";
}

function initialLanguage(): Language {
  // Keep the first render identical on the server and in the browser. The
  // client preference is applied after hydration so a locale change cannot
  // duplicate the page tree or cause a full-page flash.
  return "zh";
}

function preferredClientLanguage(): Language {
  if (typeof window === "undefined") return "zh";
  const cached = window.localStorage.getItem(LOCALE_CACHE_KEY);
  if (isLanguage(cached)) return cached;
  const cookie = document.cookie.match(/(?:^|; )ia_locale=([^;]*)/);
  const cookieLocale = cookie ? decodeURIComponent(cookie[1]) : null;
  if (isLanguage(cookieLocale)) return cookieLocale;
  return detectSystemLanguage();
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [languageReady, setLanguageReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 3000);
    void fetch("/api/settings", { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as { settings?: { locale?: string } };
      })
      .then((payload) => {
        const locale = payload?.settings?.locale;
        if (!mounted) return;
        if (locale === "zh" || locale === "en") {
          setLanguage(locale);
          window.localStorage.setItem(LOCALE_CACHE_KEY, locale);
          return;
        }
        setLanguage(preferredClientLanguage());
    })
    .catch(() => {
      if (mounted) setLanguage(preferredClientLanguage());
    })
    .finally(() => {
      if (mounted) setLanguageReady(true);
    });
    return () => {
      mounted = false;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({ language, setLanguage, t: (key, values) => translate(language, key, values) }),
    [language],
  );

  return (
    <LanguageContext.Provider value={value}>
      <div style={{ visibility: languageReady ? "visible" : "hidden" }} aria-busy={!languageReady}>
        {children}
      </div>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used inside LanguageProvider");
  return context;
}
