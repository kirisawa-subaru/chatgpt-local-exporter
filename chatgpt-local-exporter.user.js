// ==UserScript==
// @name         ChatGPT Local Incremental Exporter
// @namespace    local.chatgpt.exporter
// @version      0.2.5
// @description  Export ChatGPT conversations and Projects from the logged-in web app to a local zip.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const EXPORTER_NAME = "chatgpt-local-exporter";
  const EXPORTER_VERSION = "0.2.5";
  const LIST_LIMIT = 100;
  const PROJECT_LIST_LIMIT = 50;
  const PROJECT_CONVERSATION_LIMIT = 20;
  const REQUEST_DELAY_MIN_MS = 500;
  const REQUEST_DELAY_MAX_MS = 1500;
  const RETRY_DELAY_BASE_MS = 30000;
  const MAX_RETRIES = 3;
  const FAILURE_SKIP_THRESHOLD = 3;
  let activeRun = null;

  const encoder = new TextEncoder();

  const PROVIDERS = {
    chatgpt: {
      id: "chatgpt",
      label: "ChatGPT",
      exportPrefix: "chatgpt-export",
      stateKey: "chatgpt-local-exporter-state-v1",
      getAuthHeaders,
      fetchConversationList: chatgptFetchConversationList,
      fetchConversationDetail,
      itemId: (item) => item?.id,
      itemTitle: (item) => item?.title || item?.id || "",
      detailTitle: (conversation, item) => conversation?.title || item?.title || conversation?.conversation_id || item?.id || "Untitled",
      detailCreatedAt: (conversation, item) => conversation?.create_time || item?.create_time || "",
      detailUpdatedAt: (conversation, item) => conversation?.update_time || item?.update_time || "",
      fingerprint: chatgptConversationFingerprint,
      treePath: conversationTreePath,
      toMarkdown: conversationToMarkdown,
    },
    claude: {
      id: "claude",
      label: "Claude",
      exportPrefix: "claude-export",
      stateKey: "claude-local-exporter-state-v1",
      getAuthHeaders: claudeGetAuthHeaders,
      fetchConversationList: claudeFetchConversationList,
      fetchConversationDetail: claudeFetchConversationDetail,
      itemId: (item) => item?.uuid || item?.id,
      itemTitle: (item) => item?.name || item?.uuid || item?.id || "",
      detailTitle: (conversation, item) => conversation?.name || item?.name || conversation?.uuid || item?.uuid || "Untitled",
      detailCreatedAt: (conversation, item) => conversation?.created_at || item?.created_at || "",
      detailUpdatedAt: (conversation, item) => conversation?.updated_at || item?.updated_at || "",
      fingerprint: claudeConversationFingerprint,
      treePath: claudeConversationTreePath,
      toMarkdown: claudeConversationToMarkdown,
    },
  };

  const provider = detectProvider();

  if (!provider) return;

  class RateLimitPauseError extends Error {
    constructor(message) {
      super(message);
      this.name = "RateLimitPauseError";
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function sleepInterruptibly(ms) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < ms) {
      if (activeRun?.cancelled) throw new Error("Export stopped.");
      await sleep(Math.min(500, ms - (Date.now() - startedAt)));
    }
  }

  function randomRequestDelayMs() {
    const span = REQUEST_DELAY_MAX_MS - REQUEST_DELAY_MIN_MS;
    return REQUEST_DELAY_MIN_MS + Math.floor(Math.random() * (span + 1));
  }

  function formatDelay(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  async function pacedDelay(root, reason) {
    const delayMs = randomRequestDelayMs();
    appendLog(root, `Waiting ${formatDelay(delayMs)} before ${reason}.`);
    await sleepInterruptibly(delayMs);
  }

  function nowStamp() {
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  }

  function safeFileSegment(value, fallback) {
    const fallbackText = String(fallback || "untitled");
    const raw = String(value || "");
    const trimmed = raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .replace(/_+/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^[ ._]+|[ ._]+$/g, "");
    const fallbackSegment = fallbackText
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .replace(/_+/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^[ ._]+|[ ._]+$/g, "");
    return (trimmed || fallbackSegment || "untitled").slice(0, 140);
  }

  function safePathSegment(value, fallback) {
    return safeFileSegment(value, fallback).replace(/^\.+$/g, "_");
  }

  function safePathSegmentOrEmpty(value) {
    const segment = safePathSegment(value, "");
    return segment === "untitled" ? "" : segment;
  }

  function projectSlugFromShortUrl(shortUrl, id) {
    const raw = firstString(shortUrl);
    if (!raw) return "";

    if (id && raw.startsWith(`${id}-`)) return raw.slice(id.length + 1);

    const match = raw.match(/^g-p-[0-9a-f]+-(.+)$/i);
    return match?.[1] || raw;
  }

  function projectPathName(name, shortUrl, id) {
    return safePathSegmentOrEmpty(name) || safePathSegment(projectSlugFromShortUrl(shortUrl, id), id || "project");
  }

  function jsonStringify(value) {
    return JSON.stringify(value, null, 2);
  }

  function defaultUiState() {
    return {
      x: null,
      y: null,
      panelCollapsed: false,
      logCollapsed: false,
      dockedRight: false,
    };
  }

  function normalizeUiState(value) {
    const defaults = defaultUiState();
    const input = value && typeof value === "object" ? value : {};
    return {
      x: Number.isFinite(input.x) ? input.x : defaults.x,
      y: Number.isFinite(input.y) ? input.y : defaults.y,
      panelCollapsed: Boolean(input.panelCollapsed),
      logCollapsed: Boolean(input.logCollapsed),
      dockedRight: Boolean(input.dockedRight),
    };
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(provider.stateKey) || "{}");
      return {
        conversations: parsed.conversations || {},
        failures: parsed.failures || {},
        lastExportedAt: parsed.lastExportedAt || null,
        ui: normalizeUiState(parsed.ui),
      };
    } catch {
      return { conversations: {}, failures: {}, lastExportedAt: null, ui: defaultUiState() };
    }
  }

  function saveState(state) {
    localStorage.setItem(provider.stateKey, jsonStringify(state));
  }

  function saveUiState(ui) {
    const state = loadState();
    state.ui = normalizeUiState(ui);
    saveState(state);
  }

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  function detectProvider() {
    const hostname = location.hostname.toLowerCase();
    if (hostname === "chatgpt.com" || hostname === "chat.openai.com") return PROVIDERS.chatgpt;
    if (hostname === "claude.ai") return PROVIDERS.claude;
    return null;
  }

  function conversationFingerprint(item) {
    return provider.fingerprint(item);
  }

  function itemId(item) {
    return provider.itemId(item);
  }

  function itemTitle(item) {
    return provider.itemTitle(item);
  }

  function chatgptConversationFingerprint(item) {
    const base = String(
      item.update_time ||
        item.updated_at ||
        item.create_time ||
        item.created_at ||
        item.title ||
        ""
    );
    const location = firstString(
      item?.project?.id,
      item?.project_id,
      item?.project?.title,
      item?.project?.name,
      item?.project_title,
      item?.project_name,
      item?.tree_path,
      item?.project_path,
      item?.folder_path,
      item?.gizmo_id
    );

    return location ? `${base}|location:${location}` : base;
  }

  function claudeConversationFingerprint(item) {
    return String(item?.updated_at || item?.created_at || item?.name || item?.uuid || item?.id || "");
  }

  function formatChatTimestamp(value) {
    if (value === null || value === undefined || value === "") return "";

    const raw = String(value).trim();
    const numeric = Number(raw);
    let date;

    if (Number.isFinite(numeric) && raw !== "") {
      date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    } else {
      date = new Date(raw);
    }

    if (Number.isNaN(date.getTime())) return raw;

    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");

    return `${yy}${mm}${dd} ${hh}:${min}:${ss}`;
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  }

  function splitPathValue(value) {
    if (Array.isArray(value)) {
      return value.map((item) => firstString(item?.title, item?.name, item?.id, item)).filter(Boolean);
    }

    if (typeof value === "string" && value.trim()) {
      return value.split(/[\\/]/).map((part) => part.trim()).filter(Boolean);
    }

    return [];
  }

  function conversationTreeSegments(conversation, listItem) {
    const sources = [listItem || {}, conversation || {}];

    for (const source of sources) {
      const pathSegments = splitPathValue(
        source.tree_path ||
          source.folder_path ||
          source.project_path ||
          source.path ||
          source.breadcrumbs
      );
      if (pathSegments.length) return pathSegments.map((segment) => safePathSegment(segment, "folder"));
    }

    const project = firstString(
      listItem?.project?.title,
      listItem?.project?.name,
      listItem?.project_title,
      listItem?.project_name,
      listItem?.project?.id,
      listItem?.project_id,
      conversation?.project?.title,
      conversation?.project?.name,
      conversation?.project_title,
      conversation?.project_name,
      conversation?.project?.id,
      conversation?.project_id
    );
    const folder = firstString(
      listItem?.folder?.title,
      listItem?.folder?.name,
      listItem?.folder_title,
      listItem?.folder_name,
      listItem?.folder?.id,
      listItem?.folder_id,
      conversation?.folder?.title,
      conversation?.folder?.name,
      conversation?.folder_title,
      conversation?.folder_name,
      conversation?.folder?.id,
      conversation?.folder_id
    );

    const segments = [];

    if (project) segments.push("projects", project);
    if (folder) segments.push("folders", folder);
    if (!segments.length && conversation?.gizmo_id) segments.push("gpts", conversation.gizmo_id);
    if (!segments.length && conversation?.is_archived) segments.push("archived");
    if (!segments.length && conversation?.is_temporary_chat) segments.push("temporary");
    if (!segments.length) segments.push("chats");

    return segments.map((segment) => safePathSegment(segment, "folder"));
  }

  function conversationTreePath(conversation, listItem) {
    return conversationTreeSegments(conversation, listItem).join("/");
  }

  function matchingFailureRecord(state, item) {
    const id = itemId(item);
    if (!id) return null;

    const record = state.failures?.[id];
    if (!record) return null;

    return record.fingerprint === conversationFingerprint(item) ? record : null;
  }

  function shouldSkipForRepeatedFailure(state, item) {
    const record = matchingFailureRecord(state, item);
    return Boolean(record && record.count >= FAILURE_SKIP_THRESHOLD);
  }

  function recordConversationFailure(state, item, error) {
    const id = itemId(item);
    const fingerprint = conversationFingerprint(item);
    const previous = matchingFailureRecord(state, item);
    const count = (previous?.count || 0) + 1;

    state.failures[id] = {
      count,
      fingerprint,
      title: itemTitle(item) || previous?.title || null,
      lastError: error.message,
      lastFailedAt: new Date().toISOString(),
    };

    return count;
  }

  function clearConversationFailure(state, id) {
    if (state.failures?.[id]) delete state.failures[id];
  }

  function appendLog(root, text) {
    const line = document.createElement("div");
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    root.log.appendChild(line);
    root.log.scrollTop = root.log.scrollHeight;
  }

  function setBusy(root, busy) {
    root.exportUpdated.disabled = busy;
    root.exportAll.disabled = busy;
    root.reset.disabled = busy;
    root.stop.classList.toggle("active", busy);
  }

  function createPanel() {
    if (document.getElementById("chatgpt-local-exporter-host")) return;

    const host = document.createElement("div");
    host.id = "chatgpt-local-exporter-host";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          color-scheme: light dark;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
        }
        .trigger {
          position: fixed;
          right: 0;
          bottom: 16px;
          z-index: 2147483647;
          width: 36px;
          height: 36px;
          border: 1px solid rgba(255, 255, 255, 0.24);
          border-radius: 8px 0 0 8px;
          background: rgba(32, 32, 34, 0.94);
          color: #fff;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.38);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          font-weight: 700;
          line-height: 1;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          opacity: 0.82;
          transition: opacity 160ms;
        }
        .trigger:hover {
          opacity: 1;
        }
        .trigger.hidden {
          display: none;
        }
        @media (forced-colors: active) {
          .trigger {
            border: 1px solid ButtonText;
            background: ButtonFace;
            color: ButtonText;
            box-shadow: none;
            opacity: 1;
          }
        }
        .box {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          width: 280px;
          box-sizing: border-box;
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 12px;
          background: rgba(36, 36, 38, 0.88);
          color: #e8e8e8;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.16);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          overflow: hidden;
          transition: box-shadow 140ms ease, opacity 140ms ease;
        }
        .box.hidden {
          display: none;
        }
        .box.dragging {
          opacity: 0.92;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.36);
          transition: none;
        }
        @media (prefers-color-scheme: light) {
          .box {
            background: rgba(255, 255, 255, 0.92);
            border-color: rgba(0, 0, 0, 0.08);
            color: #1a1a1a;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
          }
          .box.dragging {
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.06);
          }
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          cursor: grab;
          font-size: 12.5px;
          font-weight: 600;
          letter-spacing: -0.01em;
          user-select: none;
        }
        @media (prefers-color-scheme: light) {
          .header {
            border-bottom-color: rgba(0, 0, 0, 0.05);
          }
        }
        .dragging .header {
          cursor: grabbing;
        }
        .title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          opacity: 0.7;
        }
        .menu-wrap {
          position: relative;
        }
        .menu-btn {
          appearance: none;
          border: 0;
          background: transparent;
          color: inherit;
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
          padding: 2px 4px;
          opacity: 0.35;
          transition: opacity 120ms;
          border-radius: 4px;
        }
        .menu-btn:hover {
          opacity: 0.7;
        }
        .menu-dropdown {
          display: none;
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 4px;
          min-width: 120px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          background: rgba(44, 44, 46, 0.96);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
          overflow: hidden;
          z-index: 10;
        }
        .menu-dropdown.open {
          display: block;
        }
        @media (prefers-color-scheme: light) {
          .menu-dropdown {
            background: rgba(255, 255, 255, 0.98);
            border-color: rgba(0, 0, 0, 0.08);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
          }
        }
        .menu-item {
          display: block;
          width: 100%;
          border: none;
          border-radius: 0;
          background: transparent;
          color: inherit;
          cursor: pointer;
          font-family: inherit;
          font-size: 12px;
          font-weight: 500;
          line-height: 1;
          padding: 10px 14px;
          text-align: left;
          opacity: 0.7;
          transition: background 80ms;
        }
        .menu-item:hover {
          background: rgba(255, 255, 255, 0.06);
          opacity: 1;
        }
        @media (prefers-color-scheme: light) {
          .menu-item:hover {
            background: rgba(0, 0, 0, 0.04);
          }
        }
        .body {
          display: grid;
          gap: 12px;
          padding: 14px;
        }
        button {
          border: none;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.06);
          color: inherit;
          cursor: pointer;
          font-family: inherit;
          font-size: 12px;
          font-weight: 500;
          line-height: 1;
          padding: 9px 12px;
          transition: background 100ms, opacity 100ms;
        }
        button:hover {
          background: rgba(255, 255, 255, 0.10);
        }
        button:active {
          background: rgba(255, 255, 255, 0.14);
        }
        @media (prefers-color-scheme: light) {
          button {
            background: rgba(0, 0, 0, 0.04);
          }
          button:hover {
            background: rgba(0, 0, 0, 0.07);
          }
          button:active {
            background: rgba(0, 0, 0, 0.10);
          }
        }
        button.primary {
          background: #0f766e;
          color: #fff;
          font-weight: 600;
          width: 100%;
          padding: 10px 12px;
        }
        button.primary:hover {
          background: #0d6560;
        }
        button.primary:active {
          background: #0a5752;
        }
        button:disabled {
          cursor: not-allowed;
          opacity: 0.25;
        }
        button:disabled:hover {
          opacity: 0.25;
        }
        .log-shell {
          display: grid;
          gap: 6px;
        }
        .log-bar {
          align-items: center;
          display: flex;
          gap: 8px;
        }
        .log-title {
          color: inherit;
          font-size: 10.5px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          opacity: 0.3;
        }
        .log-spacer {
          flex: 1;
        }
        .stop-btn {
          border: 0;
          background: transparent;
          min-height: 0;
          padding: 2px 0;
          font-size: 10.5px;
          color: #f87171;
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms;
        }
        .stop-btn.active {
          opacity: 0.55;
          pointer-events: auto;
        }
        .stop-btn.active:hover {
          opacity: 0.85;
          background: transparent;
        }
        @media (prefers-color-scheme: light) {
          .stop-btn {
            color: #dc2626;
          }
        }
        .log-toggle {
          border: 0;
          background: transparent;
          min-height: 0;
          padding: 2px 0;
          font-size: 10.5px;
          opacity: 0.3;
        }
        .log-toggle:hover {
          opacity: 0.6;
          background: transparent;
        }
        .log {
          max-height: 140px;
          overflow: auto;
          border: 1px solid rgba(255, 255, 255, 0.04);
          border-radius: 8px;
          padding: 8px 10px;
          font: 10.5px/1.5 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          background: rgba(0, 0, 0, 0.15);
          color: inherit;
          opacity: 0.5;
        }
        @media (prefers-color-scheme: light) {
          .log {
            border-color: rgba(0, 0, 0, 0.04);
            background: rgba(0, 0, 0, 0.02);
          }
        }
        .log::-webkit-scrollbar {
          width: 4px;
        }
        .log::-webkit-scrollbar-track {
          background: transparent;
        }
        .log::-webkit-scrollbar-thumb {
          background: rgba(127, 127, 127, 0.2);
          border-radius: 2px;
        }
        .log-collapsed .log {
          display: none;
        }
      </style>
      <button class="trigger" type="button" title="Open exporter">↓</button>
      <section class="box hidden" part="box">
        <div class="header">
          <span class="title">${provider.label} Export</span>
          <div class="menu-wrap">
            <button class="menu-btn" type="button" title="More options">⋯</button>
            <div class="menu-dropdown">
              <button class="menu-item export-all" type="button">Export All</button>
              <button class="menu-item reset" type="button">Reset State</button>
            </div>
          </div>
        </div>
        <div class="body">
          <button class="primary export-updated" type="button">Export Updated</button>
          <div class="log-shell">
            <div class="log-bar">
              <span class="log-title">Activity</span>
              <span class="log-spacer"></span>
              <button class="stop-btn stop" type="button">Stop</button>
              <button class="log-toggle" type="button">Hide log</button>
            </div>
            <div class="log" aria-live="polite"></div>
          </div>
        </div>
      </section>
    `;

    const box = shadow.querySelector(".box");
    const trigger = shadow.querySelector(".trigger");
    const menuBtn = shadow.querySelector(".menu-btn");
    const menuDropdown = shadow.querySelector(".menu-dropdown");
    const root = {
      box,
      trigger,
      header: shadow.querySelector(".header"),
      log: shadow.querySelector(".log"),
      logToggle: shadow.querySelector(".log-toggle"),
      exportUpdated: shadow.querySelector(".export-updated"),
      exportAll: shadow.querySelector(".export-all"),
      reset: shadow.querySelector(".reset"),
      stop: shadow.querySelector(".stop"),
      ui: normalizeUiState(loadState().ui),
    };

    menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      menuDropdown.classList.toggle("open");
    });

    shadow.addEventListener("click", (event) => {
      if (!event.target.closest(".menu-wrap")) {
        menuDropdown.classList.remove("open");
      }
    });

    function applyTriggerPosition() {
      const y = Number.isFinite(root.ui.y) ? root.ui.y : window.innerHeight - 52;
      trigger.style.bottom = "auto";
      trigger.style.top = `${clamp(y, 0, window.innerHeight - 36)}px`;
    }

    function showPanel() {
      root.box.classList.remove("hidden");
      root.trigger.classList.add("hidden");
      applyUiState(root);
    }

    function hidePanel() {
      if (activeRun) return;
      root.box.classList.add("hidden");
      root.trigger.classList.remove("hidden");
      applyTriggerPosition();
    }

    applyTriggerPosition();

    let triggerDrag = null;

    trigger.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      triggerDrag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        boxY: trigger.getBoundingClientRect().top,
        moved: false,
      };
      trigger.setPointerCapture(event.pointerId);
    });

    trigger.addEventListener("pointermove", (event) => {
      if (!triggerDrag || event.pointerId !== triggerDrag.pointerId) return;
      const dy = event.clientY - triggerDrag.startY;
      if (Math.abs(dy) > 4) triggerDrag.moved = true;
      const y = clamp(triggerDrag.boxY + dy, 0, window.innerHeight - 36);
      trigger.style.bottom = "auto";
      trigger.style.top = `${y}px`;
      root.ui.y = y;
    });

    trigger.addEventListener("pointerup", (event) => {
      if (!triggerDrag || event.pointerId !== triggerDrag.pointerId) return;
      const wasClick = !triggerDrag.moved;
      triggerDrag = null;
      if (wasClick) {
        showPanel();
      } else {
        saveUiState(root.ui);
      }
    });

    trigger.addEventListener("pointercancel", () => {
      triggerDrag = null;
    });

    document.addEventListener("pointerdown", (event) => {
      if (root.box.classList.contains("hidden")) return;
      if (host.contains(event.target)) return;
      hidePanel();
    });

    root.logToggle.addEventListener("click", () => {
      root.ui.logCollapsed = !root.ui.logCollapsed;
      applyLogState(root);
      saveUiState(root.ui);
    });

    root.exportUpdated.addEventListener("click", () => {
      void runExport(root, { mode: "updated" });
    });

    root.exportAll.addEventListener("click", () => {
      menuDropdown.classList.remove("open");
      void runExport(root, { mode: "all" });
    });

    root.reset.addEventListener("click", () => {
      menuDropdown.classList.remove("open");
      if (!window.confirm("Reset local export state for this browser profile?")) return;
      const state = loadState();
      saveState({
        conversations: {},
        failures: {},
        lastExportedAt: null,
        ui: state.ui,
      });
      appendLog(root, "Local export and failure state reset.");
    });

    root.stop.addEventListener("click", () => {
      if (activeRun) {
        activeRun.cancelled = true;
        appendLog(root, "Stopping after current request.");
      }
    });

    installDrag(root);
    window.addEventListener("resize", () => {
      if (!root.box.classList.contains("hidden")) {
        applyUiState(root);
        saveUiState(root.ui);
      }
    });

    appendLog(root, `${provider.label} exporter ready. Nothing leaves this browser except the zip download.`);
  }

  function applyLogState(root) {
    root.box.classList.toggle("log-collapsed", root.ui.logCollapsed);
    root.logToggle.textContent = root.ui.logCollapsed ? "Show log" : "Hide log";
  }

  function applyUiState(root) {
    const ui = normalizeUiState(root.ui);
    root.ui = ui;

    applyLogState(root);

    const rect = root.box.getBoundingClientRect();
    const defaultX = window.innerWidth - rect.width - 16;
    const defaultY = window.innerHeight - rect.height - 16;
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);

    let x = Number.isFinite(ui.x) ? ui.x : defaultX;
    let y = Number.isFinite(ui.y) ? ui.y : defaultY;

    x = clamp(x, 0, maxX);
    y = clamp(y, 0, maxY);

    root.box.style.right = "auto";
    root.box.style.bottom = "auto";
    root.box.style.left = `${x}px`;
    root.box.style.top = `${y}px`;
    root.ui.x = x;
    root.ui.y = y;
  }

  function installDrag(root) {
    let drag = null;

    root.header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button")) return;

      const rect = root.box.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        boxX: rect.left,
        boxY: rect.top,
      };

      root.box.classList.add("dragging");
      root.header.setPointerCapture(event.pointerId);
    });

    root.header.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      const rect = root.box.getBoundingClientRect();
      const x = clamp(drag.boxX + dx, 0, Math.max(0, window.innerWidth - rect.width));
      const y = clamp(drag.boxY + dy, 0, Math.max(0, window.innerHeight - rect.height));

      root.box.style.left = `${x}px`;
      root.box.style.top = `${y}px`;
      root.ui.x = x;
      root.ui.y = y;
    });

    root.header.addEventListener("pointerup", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      root.box.classList.remove("dragging");
      saveUiState(root.ui);
      drag = null;
    });

    root.header.addEventListener("pointercancel", () => {
      if (!drag) return;
      root.box.classList.remove("dragging");
      applyUiState(root);
      drag = null;
    });
  }

  async function fetchJson(path, headers, options = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      if (activeRun?.cancelled) throw new Error("Export stopped.");

      try {
        const response = await fetch(path, {
          credentials: "include",
          headers,
        });

        if (response.ok) return await response.json();

        const body = await response.text().catch(() => "");
        const message = `${response.status} ${response.statusText}`.trim();

        if (response.status === 429) {
          throw new RateLimitPauseError(
            `Paused after rate limit from ${path}. Wait before exporting again.${
              body ? ` ${body.slice(0, 240)}` : ""
            }`
          );
        }

        if (![500, 502, 503, 504].includes(response.status) || attempt === MAX_RETRIES) {
          const error = new Error(`${message} while fetching ${path}${body ? `: ${body.slice(0, 240)}` : ""}`);
          error.status = response.status;
          error.path = path;
          throw error;
        }

        lastError = new Error(message);
      } catch (error) {
        if (error instanceof RateLimitPauseError) throw error;
        lastError = error;
        if (attempt === MAX_RETRIES) break;
      }

      const retryDelay = options.retryDelayMs || RETRY_DELAY_BASE_MS * attempt;
      await sleepInterruptibly(retryDelay);
    }

    throw lastError || new Error(`Failed to fetch ${path}`);
  }

  async function getAuthHeaders(root) {
    const headers = {
      accept: "application/json",
    };

    try {
      const session = await fetchJson("/api/auth/session", headers);
      if (session?.accessToken) {
        headers.authorization = `Bearer ${session.accessToken}`;
      } else {
        appendLog(root, "No access token in session response; trying cookie auth.");
      }
    } catch (error) {
      appendLog(root, `Session fetch failed; trying cookie auth. ${error.message}`);
    }

    return headers;
  }

  function chatgptPageItems(page) {
    return Array.isArray(page?.items) ? page.items : [];
  }

  async function fetchChatConversationList(root, headers) {
    const items = [];
    let offset = 0;
    let total = null;

    while (true) {
      if (activeRun?.cancelled) throw new Error("Export stopped.");

      const path = `/backend-api/conversations?offset=${offset}&limit=${LIST_LIMIT}&order=updated`;
      const page = await fetchJson(path, headers);
      const pageItems = chatgptPageItems(page);

      if (typeof page.total === "number") total = page.total;
      items.push(...pageItems);

      appendLog(root, `Listed ${items.length}${total == null ? "" : ` / ${total}`} conversations.`);

      if (!pageItems.length) break;
      if (total != null && items.length >= total) break;

      offset += pageItems.length;
      await pacedDelay(root, "the next conversation-list page");
    }

    return items;
  }

  function projectInfoFromSidebarItem(item) {
    const outer = item?.gizmo || {};
    const gizmo = outer?.gizmo || outer || {};
    const display = gizmo?.display || {};
    const id = firstString(gizmo.id, item?.gizmo_id, item?.id);
    const name = firstString(
      display.name,
      display.title,
      gizmo.name,
      gizmo.title,
      gizmo.short_url,
      id,
      "project"
    );
    const pathName = projectPathName(name, gizmo.short_url, id);

    return { id, name, pathName, raw: item };
  }

  function annotateProjectConversation(item, project) {
    return {
      ...item,
      project: {
        id: project.id,
        name: project.name,
        title: project.name,
        path: project.pathName,
      },
      project_id: project.id,
      project_name: project.name,
      project_title: project.name,
      project_path: ["projects", project.pathName],
      tree_path: ["projects", project.pathName],
    };
  }

  async function fetchProjectList(root, headers) {
    const projects = [];
    const seenProjects = new Set();
    const seenCursors = new Set();
    let cursor = "";

    while (true) {
      if (activeRun?.cancelled) throw new Error("Export stopped.");

      const params = new URLSearchParams({
        owned_only: "true",
        conversations_per_gizmo: "1",
        limit: String(PROJECT_LIST_LIMIT),
      });
      if (cursor) params.set("cursor", cursor);

      const path = `/backend-api/gizmos/snorlax/sidebar?${params.toString()}`;
      const page = await fetchJson(path, headers);
      const pageItems = chatgptPageItems(page);

      for (const item of pageItems) {
        const project = projectInfoFromSidebarItem(item);
        if (!project.id || seenProjects.has(project.id)) continue;
        seenProjects.add(project.id);
        projects.push(project);
      }

      appendLog(root, `Listed ${projects.length} ChatGPT projects.`);

      const nextCursor = firstString(page.cursor);
      if (!nextCursor || seenCursors.has(nextCursor) || !pageItems.length) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      await pacedDelay(root, "the next project-list page");
    }

    return projects;
  }

  async function fetchProjectConversations(root, headers, project) {
    const items = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let offset = 0;
    let cursor = "";

    while (true) {
      if (activeRun?.cancelled) throw new Error("Export stopped.");

      const params = new URLSearchParams({
        limit: String(PROJECT_CONVERSATION_LIMIT),
        order: "updated",
      });
      if (cursor) params.set("cursor", cursor);
      else params.set("offset", String(offset));

      const path = `/backend-api/gizmos/${encodeURIComponent(project.id)}/conversations?${params.toString()}`;
      const page = await fetchJson(path, headers);
      const pageItems = chatgptPageItems(page);
      const countBeforePage = items.length;

      for (const item of pageItems) {
        const id = firstString(item?.id);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        items.push(annotateProjectConversation(item, project));
      }

      appendLog(root, `Listed ${items.length} conversations in project ${project.name}.`);
      if (pageItems.length && items.length === countBeforePage) {
        appendLog(root, `Stopping project ${project.name} pagination after a duplicate page.`);
        break;
      }

      const nextCursor = firstString(page.cursor);
      if (nextCursor && !seenCursors.has(nextCursor)) {
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } else {
        if (!pageItems.length || pageItems.length < PROJECT_CONVERSATION_LIMIT) break;
        offset += pageItems.length;
        cursor = "";
      }

      await pacedDelay(root, `the next page for project ${project.name}`);
    }

    return items;
  }

  async function fetchProjectConversationList(root, headers) {
    let projects = [];
    const items = [];

    try {
      projects = await fetchProjectList(root, headers);
    } catch (error) {
      if (error instanceof RateLimitPauseError) throw error;
      appendLog(root, `Project listing failed; continuing without Project conversations. ${error.message}`);
      return items;
    }

    for (const [index, project] of projects.entries()) {
      if (index > 0) await pacedDelay(root, "the next project conversation list");
      try {
        items.push(...(await fetchProjectConversations(root, headers, project)));
      } catch (error) {
        if (error instanceof RateLimitPauseError) throw error;
        appendLog(root, `Project ${project.name} conversation listing failed; continuing. ${error.message}`);
      }
    }

    return items;
  }

  function mergeConversationLists(baseItems, projectItems) {
    const merged = new Map();

    for (const item of baseItems) {
      const id = firstString(itemId(item));
      if (id) merged.set(id, item);
    }

    for (const item of projectItems) {
      const id = firstString(itemId(item));
      if (!id) continue;
      const previous = merged.get(id) || {};
      merged.set(id, { ...previous, ...item });
    }

    return [...merged.values()].sort((a, b) =>
      String(b.update_time || b.updated_at || b.create_time || "").localeCompare(
        String(a.update_time || a.updated_at || a.create_time || "")
      )
    );
  }

  async function chatgptFetchConversationList(root, headers) {
    const baseItems = await fetchChatConversationList(root, headers);
    const projectItems = await fetchProjectConversationList(root, headers);
    const merged = mergeConversationLists(baseItems, projectItems);

    appendLog(
      root,
      `Merged ${merged.length} ChatGPT conversations (${baseItems.length} regular, ${projectItems.length} project).`
    );

    return merged;
  }

  async function fetchConversationDetail(id, headers) {
    return fetchJson(`/backend-api/conversation/${encodeURIComponent(id)}`, headers);
  }

  async function claudeGetAuthHeaders() {
    return {
      accept: "application/json",
    };
  }

  async function claudeOrganization(root, headers) {
    if (provider.claudeOrganization) return provider.claudeOrganization;

    const organizations = await fetchJson("/api/organizations", headers);
    const list = Array.isArray(organizations)
      ? organizations
      : organizations?.organizations || organizations?.data || [];
    const organization = list.find((item) => item?.uuid || item?.id);

    if (!organization) throw new Error("Claude organization not found; are you logged in?");

    provider.claudeOrganization = {
      id: organization.uuid || organization.id,
      raw: organization,
    };
    appendLog(root, `Using Claude organization ${provider.claudeOrganization.id}.`);

    return provider.claudeOrganization;
  }

  async function claudeFetchConversationList(root, headers) {
    const organization = await claudeOrganization(root, headers);
    const items = [];
    let offset = 0;

    while (true) {
      if (activeRun?.cancelled) throw new Error("Export stopped.");

      const path = `/api/organizations/${encodeURIComponent(
        organization.id
      )}/chat_conversations?offset=${offset}&limit=${LIST_LIMIT}`;
      const page = await fetchJson(path, headers);
      const pageItems = Array.isArray(page)
        ? page
        : Array.isArray(page?.items)
          ? page.items
          : Array.isArray(page?.data)
            ? page.data
            : Array.isArray(page?.chat_conversations)
              ? page.chat_conversations
              : [];

      items.push(...pageItems);
      appendLog(root, `Listed ${items.length} Claude conversations.`);

      if (!pageItems.length || pageItems.length < LIST_LIMIT) break;

      offset += pageItems.length;
      await pacedDelay(root, "the next Claude conversation-list page");
    }

    return items;
  }

  async function claudeFetchConversationDetail(id, headers, _item, root) {
    const organization = provider.claudeOrganization || (await claudeOrganization(root, headers));
    return fetchJson(
      `/api/organizations/${encodeURIComponent(organization.id)}/chat_conversations/${encodeURIComponent(id)}`,
      headers
    );
  }

  function mainConversationMessages(conversation) {
    const mapping = conversation?.mapping || {};
    const messages = [];
    const seen = new Set();
    let nodeId = conversation?.current_node;

    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = mapping[nodeId];
      if (node.message) messages.push(node.message);
      nodeId = node.parent;
    }

    if (messages.length) return messages.reverse();

    return Object.values(mapping)
      .map((node) => node?.message)
      .filter(Boolean)
      .sort((a, b) => Number(a.create_time || 0) - Number(b.create_time || 0));
  }

  function messageRenderKind(message) {
    if (!message) return false;
    const role = message.author?.role || "unknown";
    const hidden = message.metadata?.is_visually_hidden_from_conversation;
    const contentType = message.content?.content_type;

    if (hidden) return null;
    if (role === "system") return null;
    if (contentType === "model_editable_context") return null;
    if (contentType === "user_editable_context") return null;
    if (contentType === "thoughts") return "thought summary";
    if (contentType === "reasoning_recap") return "reasoning recap";
    return "message";
  }

  function shouldRenderMessage(message) {
    if (!messageRenderKind(message)) return false;
    return Boolean(renderMessageContent(message.content).trim());
  }

  function renderThoughtSummary(content) {
    const thoughts = Array.isArray(content?.thoughts) ? content.thoughts : [];

    if (!thoughts.length) {
      return typeof content?.content === "string" ? content.content : "";
    }

    const lines = [];

    thoughts.forEach((thought, index) => {
      const summary = thought?.summary ? String(thought.summary).trim() : `Thought ${index + 1}`;
      const chunks =
        Array.isArray(thought?.chunks) && thought.chunks.length
          ? thought.chunks
          : thought?.content
            ? [thought.content]
            : [];

      if (summary) {
        lines.push(`**${summary}**`, "");
      }

      for (const chunk of chunks) {
        const text = String(chunk || "").trim();
        if (text) lines.push(text, "");
      }
    });

    return lines.join("\n").trim();
  }

  function renderPart(part) {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return String(part ?? "");

    if (part.content_type === "image_asset_pointer" || part.asset_pointer) {
      return `[image: ${part.asset_pointer || part.file_id || "asset"}]`;
    }

    if (part.content_type === "audio_asset_pointer" || part.audio_asset_pointer) {
      return `[audio: ${part.audio_asset_pointer || part.file_id || "asset"}]`;
    }

    if (part.name || part.file_id) {
      return `[file: ${part.name || part.file_id}]`;
    }

    return ["```json", jsonStringify(part), "```"].join("\n");
  }

  function renderMessageContent(content) {
    if (!content) return "";

    if (content.content_type === "thoughts") {
      return renderThoughtSummary(content);
    }

    if (content.content_type === "reasoning_recap") {
      return typeof content.content === "string" ? content.content : "";
    }

    if (
      content.content_type === "model_editable_context" ||
      content.content_type === "user_editable_context"
    ) {
      return "";
    }

    if (Array.isArray(content.parts)) {
      return content.parts.map(renderPart).filter(Boolean).join("\n\n");
    }

    if (typeof content.text === "string") return content.text;
    if (typeof content.result === "string") return content.result;

    return ["```json", jsonStringify(content), "```"].join("\n");
  }

  function conversationToMarkdown(conversation, listItem) {
    const title = conversation.title || listItem?.title || conversation.conversation_id || listItem?.id || "Untitled";
    const id = conversation.conversation_id || listItem?.id || "";
    const created = formatChatTimestamp(conversation.create_time || listItem?.create_time || "");
    const updated = formatChatTimestamp(conversation.update_time || listItem?.update_time || "");

    const lines = [
      `# ${title}`,
      "",
      `- id: ${id}`,
      `- created: ${created}`,
      `- updated: ${updated}`,
    ];
    const project = firstString(listItem?.project?.title, listItem?.project?.name, listItem?.project_name, listItem?.project_id);
    if (project) lines.push(`- project: ${project}`);
    lines.push("");

    const messages = mainConversationMessages(conversation).filter(shouldRenderMessage);
    let turn = 0;

    for (const message of messages) {
      const role = message.author?.role || "unknown";
      const kind = messageRenderKind(message);

      if (role === "user" && kind === "message") turn += 1;
      if (turn === 0) turn = 1;

      const label = kind === "message" ? role : `${role} ${kind}`;
      lines.push("---", "", `## Turn ${turn} - ${label}`, "", normalizeMarkdownBody(renderMessageContent(message.content)), "");
    }

    return lines.join("\n").replace(/\n{4,}/g, "\n\n\n");
  }

  function markdownTitle(value, fallback) {
    return String(value || fallback || "Untitled").replace(/\s+/g, " ").trim() || "Untitled";
  }

  function normalizeMarkdownBody(value) {
    const text = String(value || "").trim();
    if (!text) return "";

    const fenceCount = (text.match(/^```/gm) || []).length;
    if (fenceCount % 2 === 0) return text;

    return `${text}\n\`\`\``;
  }

  function renderClaudeFile(file, fallbackLabel) {
    if (!file || typeof file !== "object") return "";

    const name = firstString(
      file.file_name,
      file.filename,
      file.name,
      file.title,
      file.extracted_content?.file_name,
      file.uuid,
      file.id,
      fallbackLabel
    );
    const kind = firstString(file.file_type, file.mime_type, file.type, file.media_type);

    return `[file: ${name || fallbackLabel || "attachment"}${kind ? ` (${kind})` : ""}]`;
  }

  function renderClaudeMessageText(message) {
    const chunks = [];

    if (typeof message?.text === "string" && message.text.trim()) {
      chunks.push(message.text.trim());
    }

    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part === "string" && part.trim()) {
          chunks.push(part.trim());
        } else if (typeof part?.text === "string" && part.text.trim()) {
          chunks.push(part.text.trim());
        } else if (part?.type || part?.name || part?.file_name) {
          chunks.push(renderPart(part));
        }
      }
    }

    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const files = Array.isArray(message?.files) ? message.files : [];

    for (const attachment of attachments) {
      const rendered = renderClaudeFile(attachment, "attachment");
      if (rendered) chunks.push(rendered);
    }

    for (const file of files) {
      const rendered = renderClaudeFile(file, "file");
      if (rendered) chunks.push(rendered);
    }

    return chunks.filter(Boolean).join("\n\n");
  }

  function claudeConversationTreePath(conversation, listItem) {
    const projectName = firstString(
      listItem?.project?.name,
      listItem?.project?.title,
      listItem?.project_name,
      conversation?.project?.name,
      conversation?.project?.title,
      conversation?.project_name
    );
    const projectId = firstString(listItem?.project_uuid, conversation?.project_uuid);

    if (projectName) return `projects/${safePathSegment(projectName, "project")}`;
    if (projectId) return `projects/${safePathSegment(projectId, "project")}`;
    if (conversation?.is_starred || listItem?.is_starred) return "starred";
    if (conversation?.is_temporary || listItem?.is_temporary) return "temporary";
    return "chats";
  }

  function claudeConversationToMarkdown(conversation, listItem) {
    const title = markdownTitle(conversation?.name || listItem?.name, conversation?.uuid || listItem?.uuid);
    const id = conversation?.uuid || listItem?.uuid || "";
    const created = formatChatTimestamp(conversation?.created_at || listItem?.created_at || "");
    const updated = formatChatTimestamp(conversation?.updated_at || listItem?.updated_at || "");
    const project = firstString(listItem?.project?.name, listItem?.project?.title, listItem?.project_uuid);
    const messages = (Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [])
      .slice()
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));

    const lines = [
      `# ${title}`,
      "",
      `- id: ${id}`,
      `- model: ${conversation?.model || listItem?.model || ""}`,
      `- created: ${created}`,
      `- updated: ${updated}`,
      `- starred: ${Boolean(conversation?.is_starred || listItem?.is_starred)}`,
      `- temporary: ${Boolean(conversation?.is_temporary || listItem?.is_temporary)}`,
    ];

    if (project) lines.push(`- project: ${project}`);
    lines.push("");

    let turn = 0;

    for (const message of messages) {
      const body = normalizeMarkdownBody(renderClaudeMessageText(message));
      if (!body) continue;

      const rawSender = message.sender || "unknown";
      const role = rawSender === "human" ? "user" : rawSender;
      if (role === "user") turn += 1;
      if (turn === 0) turn = 1;

      const timestamp = formatChatTimestamp(message.created_at || message.updated_at || "");
      const suffix = timestamp ? ` - ${timestamp}` : "";
      lines.push("---", "", `## Turn ${turn} - ${role}${suffix}`, "", body, "");
    }

    return lines.join("\n").replace(/\n{4,}/g, "\n\n\n");
  }

  async function runExport(root, { mode }) {
    if (activeRun) {
      appendLog(root, "An export is already running.");
      return;
    }

    activeRun = { cancelled: false };
    setBusy(root, true);

    const state = loadState();
    const runStartedAt = new Date().toISOString();
    const exported = [];
    const skipped = [];
    const suppressedFailures = [];
    const errors = [];
    const files = [];

    try {
      appendLog(root, `Starting ${provider.label} ${mode} export.`);
      const headers = await provider.getAuthHeaders(root);
      const list = await provider.fetchConversationList(root, headers);

      const candidates =
        mode === "all"
          ? list
          : list.filter((item) => state.conversations[itemId(item)] !== conversationFingerprint(item));
      const selected = [];

      for (const item of candidates) {
        if (shouldSkipForRepeatedFailure(state, item)) {
          suppressedFailures.push(item);
        } else {
          selected.push(item);
        }
      }

      appendLog(root, `${selected.length} conversations selected from ${list.length}.`);
      if (suppressedFailures.length) {
        appendLog(
          root,
          `Ignoring ${suppressedFailures.length} conversations after ${FAILURE_SKIP_THRESHOLD} failed attempts.`
        );
      }

      if (!selected.length) {
        appendLog(root, suppressedFailures.length ? "Nothing exportable after failure suppression." : "Nothing new or updated.");
        return;
      }

      for (let index = 0; index < selected.length; index += 1) {
        if (activeRun.cancelled) throw new Error("Export stopped.");

        const item = selected[index];
        const id = itemId(item);

        try {
          if (index > 0) await pacedDelay(root, "the next conversation detail");
          appendLog(root, `Fetching ${index + 1} / ${selected.length}: ${itemTitle(item) || id}`);
          const detail = await provider.fetchConversationDetail(id, headers, item, root);
          const title = provider.detailTitle(detail, item) || id;
          const safeTitle = safeFileSegment(title, "conversation");
          const shortId = String(id).slice(0, 8);
          const treePath = provider.treePath(detail, item);
          const jsonPath = `conversations/${treePath}/${id}.json`;
          const markdownPath = `markdown/${treePath}/${safeTitle}-${shortId}.md`;

          files.push({
            name: jsonPath,
            content: jsonStringify(detail),
          });
          files.push({
            name: markdownPath,
            content: provider.toMarkdown(detail, item),
          });

          exported.push({
            id,
            title,
            create_time: provider.detailCreatedAt(detail, item) || null,
            update_time: provider.detailUpdatedAt(detail, item) || null,
            fingerprint: conversationFingerprint(item),
            treePath,
            jsonPath,
            markdownPath,
            listItem: item,
          });
          clearConversationFailure(state, id);
        } catch (error) {
          if (error instanceof RateLimitPauseError) throw error;

          if (error.status === 404) {
            skipped.push({
              id,
              title: itemTitle(item) || null,
              fingerprint: conversationFingerprint(item),
              reason: "not_found",
              message: error.message,
            });
            clearConversationFailure(state, id);
            appendLog(root, `Skipped ${id}: conversation detail not found.`);
            continue;
          }

          const failureCount = recordConversationFailure(state, item, error);
          errors.push({
            id,
            title: itemTitle(item) || null,
            message: error.message,
            failureCount,
            willSkipFutureRuns: failureCount >= FAILURE_SKIP_THRESHOLD,
          });
          appendLog(root, `Failed ${id} (${failureCount} / ${FAILURE_SKIP_THRESHOLD}): ${error.message}`);
        }
      }

      const selectedIds = new Set(selected.map((item) => itemId(item)));
      const suppressedFailureIds = new Set(suppressedFailures.map((item) => itemId(item)));

      for (const item of list) {
        const id = itemId(item);
        if (!selectedIds.has(id)) {
          const failure = matchingFailureRecord(state, item);
          skipped.push({
            id,
            title: itemTitle(item) || null,
            fingerprint: conversationFingerprint(item),
            reason: suppressedFailureIds.has(id) ? "suppressed_failure" : "unchanged",
            failureCount: failure?.count || 0,
          });
        }
      }

      const manifest = {
        exporter: {
          name: EXPORTER_NAME,
          version: EXPORTER_VERSION,
          provider: provider.id,
          providerLabel: provider.label,
          origin: location.origin,
        },
        mode,
        exportedAt: new Date().toISOString(),
        runStartedAt,
        counts: {
          listed: list.length,
          selected: selected.length,
          exported: exported.length,
          skipped: skipped.length,
          suppressedFailures: suppressedFailures.length,
          failed: errors.length,
        },
        requestPacing: {
          minDelayMs: REQUEST_DELAY_MIN_MS,
          maxDelayMs: REQUEST_DELAY_MAX_MS,
          retryDelayBaseMs: RETRY_DELAY_BASE_MS,
          behavior: "serial requests with randomized delay; stop immediately on HTTP 429",
        },
        exported,
        skipped,
        errors,
      };

      files.unshift({
        name: "manifest.json",
        content: jsonStringify(manifest),
      });

      const zip = createZip(files);
      const filename = `${provider.exportPrefix}-${mode}-${nowStamp()}.zip`;
      downloadBlob(zip, filename);

      for (const record of exported) {
        state.conversations[record.id] = record.fingerprint;
      }
      state.lastExportedAt = new Date().toISOString();
      saveState(state);

      appendLog(root, `Downloaded ${filename}.`);
      if (errors.length) appendLog(root, `${errors.length} conversations failed; see manifest.json.`);
    } catch (error) {
      appendLog(root, error.message);
    } finally {
      activeRun = null;
      setBusy(root, false);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function crc32(bytes) {
    let crc = -1;
    for (let index = 0; index < bytes.length; index += 1) {
      crc ^= bytes[index];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return (crc ^ -1) >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2);
    const dosDate =
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate();
    return { dosTime, dosDate };
  }

  function writeUint16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function makeLocalHeader(fileNameBytes, dataBytes, crc, mod) {
    const header = new Uint8Array(30 + fileNameBytes.length);
    const view = new DataView(header.buffer);
    writeUint32(view, 0, 0x04034b50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 0x0800);
    writeUint16(view, 8, 0);
    writeUint16(view, 10, mod.dosTime);
    writeUint16(view, 12, mod.dosDate);
    writeUint32(view, 14, crc);
    writeUint32(view, 18, dataBytes.length);
    writeUint32(view, 22, dataBytes.length);
    writeUint16(view, 26, fileNameBytes.length);
    writeUint16(view, 28, 0);
    header.set(fileNameBytes, 30);
    return header;
  }

  function makeCentralHeader(fileNameBytes, dataBytes, crc, mod, localOffset) {
    const header = new Uint8Array(46 + fileNameBytes.length);
    const view = new DataView(header.buffer);
    writeUint32(view, 0, 0x02014b50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 20);
    writeUint16(view, 8, 0x0800);
    writeUint16(view, 10, 0);
    writeUint16(view, 12, mod.dosTime);
    writeUint16(view, 14, mod.dosDate);
    writeUint32(view, 16, crc);
    writeUint32(view, 20, dataBytes.length);
    writeUint32(view, 24, dataBytes.length);
    writeUint16(view, 28, fileNameBytes.length);
    writeUint16(view, 30, 0);
    writeUint16(view, 32, 0);
    writeUint16(view, 34, 0);
    writeUint16(view, 36, 0);
    writeUint32(view, 38, 0);
    writeUint32(view, 42, localOffset);
    header.set(fileNameBytes, 46);
    return header;
  }

  function makeEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
    const header = new Uint8Array(22);
    const view = new DataView(header.buffer);
    writeUint32(view, 0, 0x06054b50);
    writeUint16(view, 4, 0);
    writeUint16(view, 6, 0);
    writeUint16(view, 8, entryCount);
    writeUint16(view, 10, entryCount);
    writeUint32(view, 12, centralSize);
    writeUint32(view, 16, centralOffset);
    writeUint16(view, 20, 0);
    return header;
  }

  function createZip(files) {
    const parts = [];
    const centralParts = [];
    let offset = 0;
    const mod = dosDateTime(new Date());

    for (const file of files) {
      const fileNameBytes = encoder.encode(file.name);
      const dataBytes = file.content instanceof Uint8Array ? file.content : encoder.encode(String(file.content));
      const checksum = crc32(dataBytes);
      const localHeader = makeLocalHeader(fileNameBytes, dataBytes, checksum, mod);
      const centralHeader = makeCentralHeader(fileNameBytes, dataBytes, checksum, mod, offset);

      parts.push(localHeader, dataBytes);
      centralParts.push(centralHeader);
      offset += localHeader.length + dataBytes.length;
    }

    const centralOffset = offset;
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = makeEndOfCentralDirectory(files.length, centralSize, centralOffset);

    return new Blob([...parts, ...centralParts, end], { type: "application/zip" });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createPanel, { once: true });
  } else {
    createPanel();
  }
})();
