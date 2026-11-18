// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - the provider-agnostic agent loop and in-page UI.
//
// This is the Godot edition of ZeroScript. The flow is:
//
//   visual console -> controller (local HTTP relay) -> this tab
//     -> AI chat web page -> one JSON command -> controller -> Godot plugin
//
// The extension never talks to Godot directly and never executes commands
// itself: it types a prompt, waits for the model's answer, parses ONE command,
// reports it, and waits for the controller to assign the next turn (possibly to
// a different browser). That is what makes multi-browser rotation possible.
//
// Everything site-specific goes through ZSProvider (providers/*.js). This file
// may only touch its OWN UI and the provider interface.

(() => {
  "use strict";
  const P = ZSProvider;
  const T = Object.assign(
    {
      GEN_IDLE_MS: 1200,
      STABLE_MS: 12000,
      WARMUP_MS: 45000,
      RESPONSE_TIMEOUT_MS: 300000,
    },
    P.timings || {}
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const log = (...a) => console.log("[nonzeroscript]", ...a);
  const SID_KEY = "nzs-session-id";

  // ════════════════════════════════════════════════════════════════════════
  //  STATE
  // ════════════════════════════════════════════════════════════════════════
  // Camouflage bookkeeping (see the CAMOUFLAGE section): what we typed into the
  // page, and the optimistic pre-hide window for the turn it creates.
  const A = {
    injectHideUntil: 0,
    injectPreUser: 0,
    injectedTexts: [],
    chipped: new WeakMap(), // item -> { label, detail, body, category, phase, whole }
  };
  const state = {
    sessionId: null,
    browserId: "unknown",
    browser: "Browser",
    controllerOnline: null,
    editorConnected: null,
    editorProject: "",
    editorWrite: true,
    editorCSharp: null,
    editorDotnet: null,
    editorName: "",
    editorEngine: "",
    editorAdapter: "",
    editorInstructions: "",
    settings: { min_delay: 2, max_delay: 6, max_turns: 60 },
    tools: [],
    sessionState: "registered", // registered | starting | ready | busy | stopped
    starting: false,
    ready: false,
    busy: false,
    abort: false,
    currentTurn: null,
    taskId: null,
    lastError: "",
    lastReply: "",
    turns: 0,
    pollTimer: null,
    reconnectTimer: null,
    mountTimer: null,
    startedAt: 0,
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root = null;
    let bar = null;
    let els = {};
    let toastTimer = null;

    function detectBrowser() {
      const ua = navigator.userAgent || "";
      if (/\bEdg\//.test(ua)) return "Edge";
      if (/\bOPR\//.test(ua)) return "Opera";
      if (/\bFirefox\//.test(ua)) return "Firefox";
      if (/\bChrome\//.test(ua)) return "Chrome";
      return "Browser";
    }

    function build() {
      if (document.getElementById("zs-root")) {
        root = document.getElementById("zs-root");
        bar = document.getElementById("zs-bar");
        bindEls();
        return;
      }
      root = document.createElement("div");
      root.id = "zs-root";
      bar = document.createElement("div");
      bar.id = "zs-bar";
      bar.className = `zs-bar zs-prov-${P.id}`;
      bar.innerHTML = `
        <span id="zs-brand" title="NonZeroScript · 多编辑器"><span class="zs-logo">&lt;/&gt;</span><b>NonZeroScript</b></span>
        <span id="zs-dot" class="zs-dot"></span>
        <span id="zs-state">正在连接操控台…</span>
        <span id="zs-extra"></span>
        <span id="zs-spacer"></span>
        <button id="zs-console" class="zs-btn zs-btn-ghost" title="打开可视化操控台">操控台</button>
        <button id="zs-start" class="zs-btn zs-btn-main">启动</button>
        <button id="zs-stop" class="zs-btn zs-btn-stop" disabled>停止</button>
      `;
      root.appendChild(bar);
      const toast = document.createElement("div");
      toast.id = "zs-toast";
      root.appendChild(toast);
      document.documentElement.appendChild(root);
      bindEls();
      mount();
    }

    function bindEls() {
      els = {
        dot: document.getElementById("zs-dot"),
        state: document.getElementById("zs-state"),
        extra: document.getElementById("zs-extra"),
        start: document.getElementById("zs-start"),
        stop: document.getElementById("zs-stop"),
        consoleBtn: document.getElementById("zs-console"),
        toast: document.getElementById("zs-toast"),
      };
      els.start.onclick = () => {
        if (!state.ready && !state.starting) startSession();
      };
      els.stop.onclick = () => stopSession("用户点击停止");
      els.consoleBtn.onclick = () => ZSNet.openConsole();
    }

    // Put the bar where the site's composer lives. Providers export one of
    // barMount / barAnchor / composerFrame; fall back to a fixed corner.
    function mount() {
      if (!bar) return;
      if (bar.classList.contains("zs-bar-fixed")) return;
      try {
        const m = P.barMount ? P.barMount() : null;
        if (m && m.parent) {
          m.parent.insertBefore(bar, m.before || null);
          bar.classList.add("zs-bar-inline");
          if (m.inside) bar.classList.add("zs-bar-inside");
          return;
        }
        const a = P.barAnchor ? P.barAnchor() : null;
        if (a && a.parentElement) {
          a.parentElement.insertBefore(bar, a);
          bar.classList.add("zs-bar-inline");
          return;
        }
        const f = P.composerFrame ? P.composerFrame() : null;
        if (f && f.parentElement) {
          f.parentElement.insertBefore(bar, f);
          bar.classList.add("zs-bar-inline");
          return;
        }
      } catch (e) {
        log("mount failed", e);
      }
      bar.classList.add("zs-bar-fixed");
      (document.body || document.documentElement).appendChild(bar);
    }

    function ensureMounted() {
      if (!root || !bar) return;
      if (!document.getElementById("zs-root")) {
        (document.body || document.documentElement).appendChild(root);
      }
      if (!document.getElementById("zs-bar")) {
        bar.classList.remove("zs-bar-inline", "zs-bar-inside", "zs-bar-fixed");
        root.appendChild(bar);
        mount();
        return;
      }
      // A composer can appear after document_idle (SPA route change): retry the
      // in-flow mount instead of leaving the bar in the fixed corner forever.
      if (bar.classList.contains("zs-bar-fixed")) {
        bar.classList.remove("zs-bar-fixed");
        mount();
      }
    }

    function set({ tone, text, extra, startLabel, startDisabled, stopDisabled, dot }) {
      if (!els.state) return;
      bar.classList.toggle("tone-ok", tone === "ok");
      bar.classList.toggle("tone-warn", tone === "warn");
      bar.classList.toggle("tone-err", tone === "err");
      bar.classList.toggle("tone-busy", tone === "busy");
      els.state.textContent = text || "";
      els.extra.textContent = extra || "";
      if (startLabel != null) els.start.textContent = startLabel;
      if (startDisabled != null) els.start.disabled = !!startDisabled;
      if (stopDisabled != null) els.stop.disabled = !!stopDisabled;
      if (dot) els.dot.className = `zs-dot zs-dot-${dot}`;
    }

    function toast(msg, ms = 6000, kind = "") {
      if (!els.toast) return;
      els.toast.textContent = String(msg || "");
      els.toast.className = `zs-toast shown ${kind}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        els.toast.className = "zs-toast";
      }, ms);
    }

    function setBusyVisual(on) {
      bar.classList.toggle("zs-busy", !!on);
    }

    function render() {
      const settings = state.settings || {};
      const delay = `${fmtSec(settings.min_delay)}-${fmtSec(settings.max_delay)}s`;
      const provider = P.displayName || P.id;
      const extraBase = `${state.browser} · ${provider} · 延迟 ${delay}`;
      const editorName = state.editorConnected
        ? (state.editorCSharp ? "GDScript + C#" : "GDScript")
        : "";
      const editor = state.editorConnected
        ? `编辑器已连接 · ${editorName}`
        : "编辑器未连接";
      setBusyVisual(state.busy || state.starting);

      if (state.controllerOnline === false) {
        set({
          tone: "err", dot: "err",
          text: "中转未运行 · 请先启动操控台",
          extra: extraBase,
          startLabel: "重试连接", startDisabled: false, stopDisabled: !state.busy,
        });
        return;
      }
      if (state.controllerOnline === null) {
        set({ tone: "warn", dot: "warn", text: "正在连接中转…", extra: extraBase, startDisabled: true, stopDisabled: true });
        return;
      }
      if (state.lastError) {
        set({ tone: "err", dot: "warn", text: state.lastError, extra: `${extraBase} · ${editor}`, startLabel: state.ready ? "已启动" : "启动", startDisabled: state.ready || state.starting, stopDisabled: !state.busy && !state.starting });
        return;
      }
      if (state.starting) {
        set({ tone: "busy", dot: "busy", text: "正在启动会话：发送系统提示…", extra: `${extraBase} · ${editor}`, startLabel: "启动中…", startDisabled: true, stopDisabled: false });
        return;
      }
      if (state.busy) {
        set({ tone: "busy", dot: "busy", text: `执行任务 ${state.taskId || ""}…`, extra: `${extraBase} · 回合 ${state.turns}`, startLabel: "已启动", startDisabled: true, stopDisabled: false });
        return;
      }
      if (state.ready) {
        set({ tone: "ok", dot: "ok", text: `已就绪 · 等待操控台派发任务`, extra: `${extraBase} · ${editor}`, startLabel: "已启动", startDisabled: true, stopDisabled: false });
        return;
      }
      set({
        tone: "warn", dot: "ok",
        text: "会话未启动 · 点击“启动”接入轮换",
        extra: `${extraBase} · ${editor}`,
        startLabel: "启动", startDisabled: false, stopDisabled: true,
      });
    }

    function fmtSec(v) {
      const n = Number(v || 0);
      return Number.isInteger(n) ? String(n) : n.toFixed(1);
    }

    return { build, mount, ensureMounted, set, toast, render, detectBrowser };
  })();

  // ════════════════════════════════════════════════════════════════════════
  //  CONNECTION / SESSION REGISTRATION
  // ════════════════════════════════════════════════════════════════════════
  function rememberSessionId() {
    try {
      let sid = sessionStorage.getItem(SID_KEY);
      if (!sid) {
        sid = (crypto.randomUUID && crypto.randomUUID()) || `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        sessionStorage.setItem(SID_KEY, sid);
      }
      state.sessionId = sid;
    } catch {
      state.sessionId = `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  async function connect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    if (!state.sessionId) rememberSessionId();
    if (!state.browserId || state.browserId === "unknown") {
      await ZSNet.init();
      state.browserId = ZSNet.getBrowserId();
      state.browser = ui.detectBrowser();
    }
    ui.render();
    const r = await ZSNet.api(
      "/api/session/register",
      {
        sessionId: state.sessionId,
        browser: state.browser,
        browserId: state.browserId,
        provider: P.id,
        displayName: P.displayName,
        label: `${state.browser} · ${P.displayName}`,
        pageUrl: location.href,
        conversation: safeConversationKey(),
        state: state.sessionState,
        version: ZSNet.getVersion(),
      },
      8000
    );
    if (r && r.ok) {
      state.controllerOnline = true;
      state.editorConnected = r.editor ? !!r.editor.connected : null;
      state.editorProject = r.editor ? r.editor.project || "" : "";
      state.editorWrite = r.editor && r.editor.write_enabled === false ? false : true;
      state.editorCSharp = r.editor && r.editor.csharp != null ? !!r.editor.csharp : null;
      state.editorDotnet = r.editor && r.editor.dotnet != null ? !!r.editor.dotnet : null;
      if (r.editor) {
        if (r.editor.name) state.editorName = String(r.editor.name);
        if (r.editor.engine) state.editorEngine = String(r.editor.engine);
        if (r.editor.adapter) state.editorAdapter = String(r.editor.adapter);
      }
      if (typeof r.instructions === "string" && r.instructions) state.editorInstructions = r.instructions;
      if (r.settings) state.settings = r.settings;
      if (Array.isArray(r.tools)) state.tools = r.tools;
      state.lastError = "";
      log("registered", state.sessionId);
      schedulePoll(150);
      ZSNet.badge(true, "");
      if (state.pendingStart && !state.ready && !state.starting) {
        state.pendingStart = false;
        setTimeout(startSession, 50);
      }
    } else {
      state.controllerOnline = false;
      state.lastError = "";
      state.sessionState = "registered";
      log("registration failed", r && r.error);
      scheduleReconnect(2000);
      ZSNet.badge(false, "!");
    }
    ui.render();
  }

  function safeConversationKey() {
    try {
      return P.conversationKey ? P.conversationKey() : "";
    } catch {
      return "";
    }
  }

  function scheduleReconnect(ms) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => connect(), ms);
  }

  function schedulePoll(ms) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    if (!state.sessionId) return;
    const r = await ZSNet.api(
      "/api/session/poll",
      {
        sessionId: state.sessionId,
        state: state.sessionState,
        provider: P.id,
        displayName: P.displayName,
        conversation: safeConversationKey(),
      },
      15000
    );
    if (!r || !r.ok) {
      state.controllerOnline = false;
      state.editorConnected = null;
      state.lastError = "";
      ui.render();
      ZSNet.badge(false, "!");
      scheduleReconnect(2500);
      return;
    }
    state.controllerOnline = true;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    state.editorConnected = r.editor ? !!r.editor.connected : state.editorConnected;
    state.editorProject = r.editor ? r.editor.project || state.editorProject : state.editorProject;
    if (r.editor && r.editor.write_enabled != null) state.editorWrite = r.editor.write_enabled !== false;
    if (r.editor && r.editor.csharp != null) state.editorCSharp = !!r.editor.csharp;
    if (r.editor && r.editor.dotnet != null) state.editorDotnet = !!r.editor.dotnet;
    if (r.settings) state.settings = r.settings;
    ZSNet.badge(true, "");
    if (r.stop) {
      // The console asked every tab to stop.
      state.abort = true;
      try {
        P.stopGeneration && P.stopGeneration();
      } catch {}
      if (!state.busy && !state.starting) resetAfterStop();
    }
    if (r.assign && !state.busy && !state.starting && state.ready) {
      runAssignment(r.assign);
    }
    ui.render();
    // The console's performance mode sets the cadence (500 ms turbo .. 1.5 s eco).
    const pollMs = Math.max(200, Number((state.settings || {}).poll_ms) || 1200);
    schedulePoll(state.busy ? Math.max(pollMs, 2500) : pollMs);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION START / STOP
  // ════════════════════════════════════════════════════════════════════════
  async function startSession() {
    if (state.ready || state.starting || state.busy) return;
    if (state.controllerOnline === false) {
      state.pendingStart = true;
      await connect();
      return;
    }
    if (state.controllerOnline !== true) return;

    state.starting = true;
    state.abort = false;
    state.lastError = "";
    state.sessionState = "starting";
    ui.render();

    // Show the provider's known caveat once, without blocking.
    if (P.unstableWarning) ui.toast(`${P.displayName}: ${P.unstableWarning}`, 9000, "warn");

    try {
      if (P.captchaPresent && P.captchaPresent()) throw new Error("页面出现了验证码，请先在浏览器中完成验证。");
      if (P.overlayBlocking && P.overlayBlocking()) throw new Error("页面被弹窗/遮罩阻挡，请关闭后重试。");
      if (P.ensureComposerReady) {
        const mode = await P.ensureComposerReady("startup");
        if (mode && mode.ready === false) {
          throw new Error(P.modeWarning ? `${P.displayName} 模式未就绪：${P.modeWarning()}` : `${P.displayName} 模式未就绪，请新开对话或刷新页面。`);
        }
      } else if (P.enforceComposer) {
        P.enforceComposer();
      }

      if (!state.tools.length || !state.editorInstructions) {
        const t = await ZSNet.api("/api/tools", {}, 8000);
        if (t && t.ok && Array.isArray(t.tools)) state.tools = t.tools;
        if (t && typeof t.instructions === "string" && t.instructions) state.editorInstructions = t.instructions;
        if (t && t.editor) {
          if (t.editor.name) state.editorName = String(t.editor.name);
          if (t.editor.engine) state.editorEngine = String(t.editor.engine);
          if (t.editor.id) state.editorAdapter = String(t.editor.id);
        }
      }

      const prompt = ZS.systemPrompt({
        siteName: P.displayName,
        tools: state.tools,
        editorName: state.editorName,
        editorInstructions: state.editorInstructions,
        editor: {
          connected: state.editorConnected,
          project: state.editorProject,
          adapter: state.editorAdapter,
          engine: state.editorEngine,
          write_enabled: state.editorWrite,
          csharp: !!state.editorCSharp,
          dotnet: !!state.editorDotnet,
        },
        providerNotes: P.promptExtra || "",
        customPrompt: state.settings.custom_prompt || "",
      });

      // The prompt is a simulated input too: wait the configured random delay.
      const wait = ZS.randomDelay(state.settings.min_delay, state.settings.max_delay);
      if (!(await countdown(wait, `等待 ${(wait / 1000).toFixed(1)} 秒后发送系统提示`))) return;
      if (state.abort) return;

      const base = markTurnStart();
      await typeAndSendInjected(prompt);
      state.sessionState = "busy";
      ui.set({ tone: "busy", dot: "busy", text: `${P.displayName} 正在阅读系统提示…`, extra: "启动会话" });
      const res = await waitForReply(base, "start");
      if (state.abort) return;

      if (res.kind === "text" && ZSParse.hasCommandShape(res.text)) {
        // It ignored "reply READY". Nudge once, then accept the session anyway.
        const wait2 = ZS.randomDelay(state.settings.min_delay, state.settings.max_delay);
        if (!(await countdown(wait2, "等待发送启动纠正"))) return;
        const base2 = markTurnStart();
        await typeAndSendInjected(
          "Do not run any command during startup. Reply with plain text: READY. " +
            "Wait for the first task; the controller will send it."
        );
        await waitForReply(base2, "start-ack");
      }
      if (state.abort) return;

      state.ready = true;
      state.starting = false;
      state.sessionState = "ready";
      state.startedAt = Date.now();
      ui.toast(`${P.displayName} 会话已接入轮换。在操控台添加任务即可。`, 6000, "ok");
      schedulePoll(50);
    } catch (e) {
      state.ready = false;
      state.lastError = String((e && e.message) || e).slice(0, 180);
      ui.toast(state.lastError, 9000, "err");
      log("start failed", e);
    } finally {
      state.starting = false;
      if (!state.ready && (state.sessionState === "starting" || state.sessionState === "busy")) {
        state.sessionState = "registered";
      }
      ui.render();
    }
  }

  function markTurnStart() {
    let count = 0;
    let id = null;
    let text = "";
    try {
      count = P.assistantCount ? P.assistantCount() : 0;
      id = P.lastAssistantId ? P.lastAssistantId() : null;
      const r = P.readAssistant ? P.readAssistant() : null;
      text = (r && r.reply) || "";
    } catch {}
    return { count, id, text, at: Date.now() };
  }

  function stopSession(reason) {
    state.abort = true;
    try {
      P.stopGeneration && P.stopGeneration();
    } catch {}
    state.ready = false;
    state.starting = false;
    state.busy = false;
    state.sessionState = "stopped";
    state.currentTurn = null;
    ui.render();
    // Always tell the controller, even when idle: otherwise it would keep
    // dispatching new turns to a tab the user has switched off.
    if (state.sessionId) {
      ZSNet.api("/api/session/stop", { sessionId: state.sessionId, reason }, 8000);
    }
    ui.toast("已停止。再次点击“启动”可重新接入。", 5000, "warn");
  }

  function resetAfterStop() {
    state.abort = false;
    state.busy = false;
    state.ready = false;
    state.starting = false;
    state.sessionState = "stopped";
    state.currentTurn = null;
    ui.render();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ASSIGNMENT EXECUTION
  // ════════════════════════════════════════════════════════════════════════
  async function runAssignment(assign) {
    if (state.busy || state.starting) return;
    state.busy = true;
    state.abort = false;
    state.currentTurn = assign;
    state.taskId = assign.taskId || null;
    state.sessionState = "busy";
    state.turns = assign.turnIndex || state.turns + 1;
    state.lastError = "";
    ui.render();

    const min = assign.minDelay != null ? assign.minDelay : state.settings.min_delay;
    const max = assign.maxDelay != null ? assign.maxDelay : state.settings.max_delay;
    const wait = ZS.randomDelay(min, max);

    try {
      if (P.captchaPresent && P.captchaPresent()) throw new Error("页面出现了验证码，任务已暂停。");
      const okWait = await countdown(wait, `等待 ${(wait / 1000).toFixed(1)} 秒后输入`);
      if (!okWait || state.abort) return await finishAborted(assign);

      const base = markTurnStart();
      await typeAndSendInjected(assign.text);
      ui.set({ tone: "busy", dot: "busy", text: `${P.displayName} 正在思考…`, extra: `任务 ${state.taskId} · 回合 ${state.turns}` });

      const res = await waitForReply(base, assign.turnId);
      if (state.abort) return await finishAborted(assign);

      if (res.kind === "stopped") {
        await reportTurn(assign, { reply: res.text || "", error: "stopped", done: false });
        ui.toast("浏览器内检测到停止，任务已暂停。", 6000, "warn");
        return;
      }
      if (res.kind === "timeout" || res.kind === "empty") {
        const msg = res.kind === "timeout" ? "等待 AI 回复超时" : "AI 没有返回内容";
        await reportTurn(assign, { reply: res.text || "", error: msg, done: true });
        ui.toast(msg, 7000, "err");
        return;
      }

      const siteError = readSiteError();
      const calls = ZSParse.parseToolCalls(res.text);
      let command = null;
      let parseError = null;

      if (calls.length > 1) {
        parseError = "multiple";
      } else if (calls.length === 1) {
        command = { command: calls[0].tool, params: calls[0].arguments || {} };
      } else {
        parseError = ZSParse.diagnose(res.text);
        // A reply cut off by an output limit can still hold a complete command
        // with only the closing braces missing. Recover it when provable.
        if (parseError === "unclosed" || parseError === "malformed") {
          const salvaged = ZSParse.salvageCutOff(res.text);
          if (salvaged) {
            command = { command: salvaged.tool, params: salvaged.arguments || {} };
            parseError = null;
          }
        }
      }

      if (command) {
        const mismatch = ZSParse.codeLanguageWarning(command, res.text);
        if (mismatch) {
          log("language mismatch", mismatch);
          ui.toast(mismatch, 9000, "warn");
        }
      }

      if (siteError && !command) {
        await reportTurn(assign, { reply: res.text || "", error: siteError, done: true });
        ui.toast(`站点提示：${siteError}`, 9000, "err");
        return;
      }

      const chip = showChip(
        res.item,
        command ? command.command : null,
        parseError ? "err" : command ? "run" : "done",
        parseError ? "格式错误" : command ? "执行中…" : "任务完成"
      );

      const feedback = parseError
        ? ZS.FEEDBACK.parseError(parseError, command ? command.command : ZSParse.toolNameFromText(res.text))
        : "";

      const report = await reportTurn(assign, {
        reply: res.text || "",
        command,
        parseError,
        feedback,
        done: !command && !parseError,
      });

      if (chip) {
        if (parseError) updateChip(chip, "err", "需要重写命令");
        else if (command) {
          if (report && report.ok && report.executed) {
            updateChip(chip, report.okResult === false ? "err" : "done",
              report.okResult === false ? "执行失败" : "完成");
          } else {
            updateChip(chip, report && report.ok ? "done" : "err", report && report.ok ? "已提交" : "未提交");
          }
        } else {
          updateChip(chip, "done", "任务完成");
        }
      }

      if (report && report.taskState === "paused") {
        ui.toast("操控台暂停了任务。", 6000, "warn");
      }
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 220);
      log("assignment failed", e);
      state.lastError = msg;
      ui.toast(msg, 9000, "err");
      await reportTurn(assign, { reply: "", error: msg, done: true });
    } finally {
      state.busy = false;
      state.currentTurn = null;
      state.abort = false;
      state.sessionState = state.ready ? "ready" : "stopped";
      state.lastError = "";
      ui.render();
      if (state.ready) schedulePoll(200);
      else schedulePoll(1500);
    }
  }

  async function finishAborted(assign) {
    if (assign) await reportTurn(assign, { reply: "", error: "stopped", done: false });
    state.busy = false;
    state.currentTurn = null;
    state.abort = false;
    state.sessionState = state.ready ? "ready" : "stopped";
    ui.render();
  }

  async function reportTurn(assign, payload) {
    const body = Object.assign(
      {
        sessionId: state.sessionId,
        turnId: assign.turnId,
        taskId: assign.taskId,
        provider: P.id,
        displayName: P.displayName,
        browser: state.browser,
        reply: ZS.clip(payload.reply || "", 30000),
        done: false,
      },
      payload
    );
    const r = await ZSNet.api("/api/session/report", body, 120000);
    if (!r || !r.ok) {
      state.lastError = (r && r.error) || "上报失败";
      ui.toast(`上报失败：${state.lastError}`, 8000, "err");
    }
    return r;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER
  // ════════════════════════════════════════════════════════════════════════
  async function waitForReply(base) {
    const t0 = Date.now();
    let lastText = "";
    let lastChange = Date.now();
    let sawNew = false;
    let lastKind = "";

    while (Date.now() - t0 < (T.RESPONSE_TIMEOUT_MS || 300000)) {
      if (state.abort) return { kind: "stopped", text: lastText, item: null };

      let r = { present: false, reply: "", item: null };
      try {
        r = P.readAssistant() || r;
      } catch {}
      const text = String(r.reply || "").trim();

      let fresh = false;
      let gen = false;
      try {
        const count = P.assistantCount ? P.assistantCount() : 0;
        const id = P.lastAssistantId ? P.lastAssistantId() : null;
        if (base.id && id) fresh = id !== base.id;
        else if (base.count != null) fresh = count > base.count;
        fresh = fresh || (!!text && text !== base.text && Date.now() - t0 > 1200);
        gen = P.isGenerating ? !!P.isGenerating() : false;
      } catch {}

      if (fresh) sawNew = true;
      if (sawNew && text) {
        if (text !== lastText) {
          lastText = text;
          lastChange = Date.now();
        }
        const idle = Date.now() - lastChange;
        const open = ZSParse.hasOpenToolBlock(text);
        if (!gen && !open && idle >= Math.min(T.GEN_IDLE_MS || 1000, 2500)) {
          return { kind: "text", text, item: r.item };
        }
        if (gen && !open && idle >= (T.STABLE_MS || 12000)) {
          // The site's "generating" flag is stuck but the text is frozen.
          return { kind: "text", text, item: r.item };
        }
      }

      if (!sawNew && Date.now() - t0 > (T.WARMUP_MS || 45000)) {
        return { kind: "empty", text: "", item: null };
      }

      // Truncation: click the site's "Continue" control and keep waiting.
      try {
        if (sawNew && P.findContinueBtn && P.findContinueBtn() && Date.now() - lastChange > 2500) {
          P.clickContinueBtn && P.clickContinueBtn();
          lastChange = Date.now();
        }
      } catch {}

      if (P.turnHalted && P.turnHalted() && Date.now() - t0 > 1500) {
        return { kind: "stopped", text: lastText, item: r.item };
      }

      const kind = P.isGenerating ? "gen" : "idle";
      if (kind !== lastKind) lastKind = kind;
      await sleep(400);
    }
    return { kind: "timeout", text: lastText, item: null };
  }

  function readSiteError() {
    try {
      if (!P.scanError) return "";
      const e = P.scanError();
      if (!e) return "";
      if (typeof e === "string") return e;
      return e.text || e.reason || e.message || "";
    } catch {
      return "";
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE (hide the protocol, show custom-icon chips - ZeroScript style)
  //
  //  The conversation must not show wire protocol: the prompts Non sends (the
  //  system prompt, task dispatches, tool results, repair notes) and the raw
  //  command blocks the model writes for Non. Injected turns are hidden whole
  //  and represented by a small expandable chip with a custom icon; command
  //  blocks inside an assistant turn are hidden by the provider
  //  (findToolBlockSpot -> .zs-tool-hide) and represented by a tool chip.
  //  Site-native tool/agent cards are hidden the same way (P.siteToolSel).
  // ════════════════════════════════════════════════════════════════════════
  function normText(t) {
    return String(t || "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  // What kind of injected turn this is (null = leave visible). Checked BEFORE
  // the tracked-text list so a repair note that quotes a {"command": …} example
  // is read as protocol, not as a task.
  function injectedKind(txt) {
    const t = String(txt || "").replace(/^\s+/, "");
    if (!t) return null;
    if (t.includes(ZS.SYS_MARKER)) return "sys";
    if (t.includes(ZS.RESEND_MARKER)) return "remind";
    if (/^Output of '[^']*'[:：]/.test(t)) return "result";
    if (/^ERROR\b/.test(t)) return "repair";
    if (/^\(System note:/.test(t)) return "repair";
    if (/^Continue\.$/.test(t)) return "continue";
    if (/^Do not run any command during startup\./.test(t)) return "startup";
    if (/^Task finished\.$/.test(t)) return "result";
    const n = normText(t);
    if (A.injectedTexts.some((x) => normText(x) === n)) return "task";
    return null;
  }

  const INJECTED_CHIP = {
    sys: ["系统提示", "gear"],
    remind: ["系统提示重述", "remind"],
    result: ["工具结果", "result"],
    repair: ["修复反馈", "error"],
    continue: ["继续", "result"],
    startup: ["启动提示", "gear"],
    task: ["任务", "task"],
  };

  // Every text Non typed into the page goes through here: remembered for the
  // camouflage sweep, with an optimistic pre-hide window so the raw turn never
  // paints before the sweep can mask it.
  function typeAndSendInjected(text) {
    A.injectedTexts.push(String(text || ""));
    if (A.injectedTexts.length > 60) A.injectedTexts.shift();
    try {
      A.injectPreUser = P.userCount ? P.userCount() : 0;
    } catch {
      A.injectPreUser = 0;
    }
    A.injectHideUntil = Date.now() + 8000;
    return Promise.resolve(P.typeAndSend(text)).then((r) => {
      // The send completes asynchronously on some sites - keep the window open.
      A.injectHideUntil = Math.max(A.injectHideUntil, Date.now() + 2500);
      return r;
    });
  }

  const SVG = (p) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    read: SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    edit: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    scene: SVG('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
    run: SVG('<polygon points="6 3 20 12 6 21 6 3"/>'),
    tool: SVG('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/>'),
    result: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    task: SVG('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
    check: SVG('<polyline points="20 6 9 17 4 12"/>'),
    remind: SVG('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    error: SVG('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6h.09A1.65 1.65 0 0 0 12 3.09 2 2 0 0 1 16 3v.09A1.65 1.65 0 0 0 19.4 6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V15a2 2 0 0 1-2 2z"/>'),
    agent: SVG('<rect x="4" y="8" width="16" height="12" rx="3"/><circle cx="9" cy="14" r="1.4"/><circle cx="15" cy="14" r="1.4"/><line x1="12" y1="8" x2="12" y2="4"/><circle cx="12" cy="3" r="1.2"/>'),
  };
  const SPIN = '<span class="zs-spin"></span>';

  function iconFor(name, phase) {
    if (phase === "run") return SPIN;
    if (phase === "err") return ICONS.error;
    if (phase === "done") return ICONS.check;
    return ICONS[name] || ICONS.tool;
  }

  // Chip = the custom pattern that REPLACES hidden protocol content: an icon,
  // a label, an optional detail line, and a click-to-expand raw body.
  function decorateChip(item, opts) {
    const { label, detail = "", body = "", category = "tool", phase = "done", whole = false } = opts;
    let chip = item.querySelector(".zs-chip");
    const hasBody = !!body;
    const sig = `${phase}|${whole ? 1 : 0}|${label}|${detail}|${hasBody ? body.length : 0}`;
    if (!chip) {
      chip = document.createElement("div");
      chip.__zsItem = item;
    }
    if (chip.dataset.csig !== sig) {
      chip.dataset.csig = sig;
      chip.dataset.cat = category;
      chip.className = `zs-chip ${phase}`;
      chip.innerHTML =
        `<div class="zs-chip-head">` +
        `<span class="zs-chip-ic">${iconFor(category, phase)}</span>` +
        `<span class="zs-chip-tx"></span>` +
        `<span class="zs-chip-dt"></span>` +
        (hasBody
          ? `<span class="zs-chip-cv">${SVG('<polyline points="6 9 12 15 18 9"/>')}</span>`
          : "") +
        `</div>` +
        (hasBody ? `<div class="zs-chip-body"><pre></pre></div>` : "");
      chip.querySelector(".zs-chip-tx").textContent = label;
      if (detail) chip.querySelector(".zs-chip-dt").textContent = detail;
      if (hasBody) {
        chip.querySelector(".zs-chip-body pre").textContent = body;
        const head = chip.querySelector(".zs-chip-head");
        head.style.cursor = "pointer";
        head.onclick = () => chip.classList.toggle("open");
      }
    }
    if (P.chipAtItemLevel || whole) {
      // Pin at the turn root: stable across the site's content re-renders.
      if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
    } else {
      // Otherwise the provider names the spot where it hid the raw block.
      let spot = null;
      try {
        spot = P.findToolBlockSpot ? P.findToolBlockSpot(item, chip) : null;
      } catch {}
      if (spot && spot.parent) {
        if (chip.parentElement !== spot.parent || chip.nextElementSibling !== spot.ref) {
          spot.parent.insertBefore(chip, spot.ref || null);
        }
      } else if (chip.parentElement !== item) {
        item.insertBefore(chip, item.firstChild);
      }
    }
    if (whole) item.classList.add("zs-hidden");
    A.chipped.set(item, { ...opts });
    return chip;
  }

  // Strip every trace of decoration from a node (sites recycle turn nodes).
  function resetDecoration(item) {
    const chip = item.querySelector(".zs-chip");
    if (chip) chip.remove();
    item.classList.remove("zs-hidden");
    item.querySelectorAll(".zs-tool-hide").forEach((e) => e.classList.remove("zs-tool-hide"));
    item.querySelectorAll(".zs-cmd-mask").forEach((e) => e.classList.remove("zs-cmd-mask"));
    item.querySelectorAll(".zs-cmd-mask-all").forEach((e) => e.classList.remove("zs-cmd-mask-all"));
    delete item.__zsFor;
    A.chipped.delete(item);
  }

  function itemVisibleText(item) {
    try {
      return P.classifyText ? P.classifyText(item, ".zs-chip") : P.itemText ? P.itemText(item) : item.textContent || "";
    } catch {
      return item.textContent || "";
    }
  }

  function chipForInjected(item, kind, txt) {
    const [label, icon] = INJECTED_CHIP[kind] || ["消息", "tool"];
    const m = /^Output of '([^']+)'/.exec(String(txt || "").trim());
    const detail = m ? m[1] : kind === "task" ? String(txt || "").trim().slice(0, 60) : "";
    decorateChip(item, {
      label,
      detail,
      body: String(txt || "").slice(0, 4000),
      category: icon,
      phase: kind === "repair" ? "err" : kind === "task" ? "task" : kind === "result" || kind === "continue" ? "result" : "sys",
      whole: true,
    });
    item.__zsFor = normText(txt);
  }

  function chipForCommand(item, txt, agentOnly) {
    const saved = A.chipped.get(item);
    const tool = agentOnly ? "Agent" : ZSParse.toolNameFromText(txt || "");
    const label = tool || "命令";
    if (saved && saved.label === label && !saved.whole) {
      // Rebuild only if the site wiped the DOM chip.
      if (!item.querySelector(".zs-chip")) {
        decorateChip(item, saved);
      }
      return;
    }
    decorateChip(item, {
      label,
      detail: "",
      body: "",
      category: agentOnly ? "agent" : ZS.toolCategory(tool || "tool"),
      // State from the block itself: an OPEN tool block is still streaming.
      // The turn loop (showChip/updateChip) owns the phase afterwards.
      phase: saved && saved.phase ? saved.phase : ZSParse.hasOpenToolBlock(txt || "") ? "run" : "done",
      whole: false,
    });
  }

  function sweepItem(item) {
    const isUser = P.isUserItem(item);
    const txt = itemVisibleText(item);
    const kind = isUser ? injectedKind(txt) : null;
    if (kind) {
      if (item.__zsFor === normText(txt) && item.querySelector(".zs-chip")) {
        item.classList.add("zs-hidden");
        return;
      }
      chipForInjected(item, kind, txt);
      return;
    }
    if (item.classList.contains("zs-hidden") && !item.__zsFor && txt.trim()) {
      // Optimistic pre-hide of a turn that turned out NOT to be ours.
      item.classList.remove("zs-hidden");
    }
    if (item.__zsFor && item.__zsFor !== normText(txt)) {
      resetDecoration(item); // recycled node
    }
    if (isUser) return;

    // Assistant turn: hide command blocks and site tool/agent cards, then
    // represent them with one chip.
    let hidAny = false;
    try {
      hidAny = !!P.findToolBlockSpot && !!P.findToolBlockSpot(item, null);
    } catch {}
    if (!hidAny) {
      // Provider without range hiding: mask obvious command blocks only.
      for (const pre of item.querySelectorAll("pre")) {
        if (pre.closest(".zs-chip")) continue;
        if (ZSParse.hasCommandShape(pre.textContent || "")) {
          pre.classList.add("zs-tool-hide");
          hidAny = true;
        }
      }
    }
    let agentCards = 0;
    const sel = P.siteToolSel || "";
    if (sel) {
      for (const el of item.querySelectorAll(sel)) {
        if (el.closest(".zs-chip")) continue;
        el.classList.add("zs-tool-hide");
        agentCards++;
      }
    }
    const already = !!item.querySelector(".zs-tool-hide");
    if (hidAny || agentCards || already) {
      chipForCommand(item, txt, !hidAny && agentCards > 0);
    }
  }

  function sweep() {
    const items = P.allItems ? P.allItems() : [];
    for (const item of items) {
      try {
        sweepItem(item);
      } catch (e) {
        log("sweep", e);
      }
    }
  }

  let sweepQueued = false;
  function scheduleSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    requestAnimationFrame(() => {
      sweepQueued = false;
      sweep();
    });
  }

  // Synchronous pre-hide: the raw text of a freshly injected turn must not
  // paint for even one frame before the sweep builds its chip.
  function preHideWholeItems() {
    const items = P.allItems ? P.allItems() : [];
    if (A.injectHideUntil && Date.now() < A.injectHideUntil) {
      const users = items.filter((it) => P.isUserItem(it));
      const last = users[users.length - 1];
      if (
        last &&
        !last.classList.contains("zs-hidden") &&
        users.length > (A.injectPreUser || 0)
      ) {
        last.classList.add("zs-hidden");
        A.injectHideUntil = 0; // one-shot: this turn is now masked
      }
    }
    for (const item of items) {
      if (item.classList.contains("zs-hidden")) continue;
      if (!P.isUserItem(item)) continue;
      const txt = itemVisibleText(item);
      if (injectedKind(txt)) item.classList.add("zs-hidden");
    }
  }

  function camouflageStart() {
    const mo = new MutationObserver(() => {
      preHideWholeItems();
      scheduleSweep();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Belt-and-braces: a low-frequency sweep regardless of visibility or
    // mutation timing, so the camouflage always converges.
    setInterval(scheduleSweep, 1500);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleSweep();
    });
    scheduleSweep();
  }

  // ── Compatibility wrappers for the turn loop (runAssignment) ─────────────
  function showChip(item, tool, kind, detail) {
    if (!item) return null;
    try {
      // The provider hides the raw command range on the way (its real job).
      P.findToolBlockSpot && P.findToolBlockSpot(item, null);
    } catch {}
    return decorateChip(item, {
      label: tool || "NonZeroScript",
      detail: detail || "",
      body: "",
      category: ZS.toolCategory(tool || "tool"),
      phase: kind === "run" ? "run" : kind === "err" ? "err" : "done",
      whole: false,
    });
  }

  function updateChip(chip, kind, text) {
    if (!chip) return;
    const phase = kind === "run" ? "run" : kind === "err" ? "err" : "done";
    const item = chip.__zsItem;
    const saved = item ? A.chipped.get(item) : null;
    if (saved) saved.phase = phase;
    chip.className = `zs-chip ${phase}${chip.classList.contains("open") ? " open" : ""}`;
    const ic = chip.querySelector(".zs-chip-ic");
    if (ic) ic.innerHTML = iconFor(chip.dataset.cat || "tool", phase);
    const d = chip.querySelector(".zs-chip-dt");
    if (d) d.textContent = text || "";
    if (chip.dataset.csig) chip.dataset.csig = chip.dataset.csig.replace(/^[^|]*/, phase);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ════════════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ════════════════════════════════════════════════════════════════════════
  async function countdown(ms, label) {
    const t0 = Date.now();
    while (true) {
      if (state.abort) return false;
      const left = ms - (Date.now() - t0);
      if (left <= 0) break;
      ui.set({
        tone: "busy", dot: "busy",
        text: `${label} · ${(left / 1000).toFixed(1)}s`,
        extra: state.currentTurn ? `任务 ${state.taskId || ""} · 回合 ${state.turns}` : "启动会话",
      });
      await sleep(Math.min(200, left));
    }
    return !state.abort;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════════════════════
  async function boot() {
    rememberSessionId();
    ui.build();
    ui.render();
    P.init && P.init({ diag: (ev, data) => log(ev, data || "") });
    camouflageStart();
    await ZSNet.init();
    state.browserId = ZSNet.getBrowserId();
    state.browser = ui.detectBrowser();
    // The popup asks the page for its live state and can reload a stale tab.
    chrome.runtime.onMessage?.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      if (msg.type === "nzs-reload") {
        location.reload();
        return false;
      }
      if (msg.type === "nzs-status") {
        sendResponse({
          ok: true,
          provider: P.id,
          displayName: P.displayName,
          sessionId: state.sessionId,
          sessionState: state.sessionState,
          ready: state.ready,
          busy: state.busy,
          starting: state.starting,
          controllerOnline: state.controllerOnline,
          editorConnected: state.editorConnected,
          taskId: state.taskId,
          turns: state.turns,
          lastError: state.lastError,
        });
        return false;
      }
      return false;
    });
    await connect();

    // Keep the bar alive across SPA re-renders.
    state.mountTimer = setInterval(() => ui.ensureMounted(), 2500);

    // Best-effort detach. Must go through the background worker: a page-world
    // sendBeacon carries the chat site's Origin and the controller rejects
    // cross-origin calls by design.
    window.addEventListener("beforeunload", () => {
      try {
        ZSNet.api(`/api/session/close?session=${encodeURIComponent(state.sessionId || "")}`, {}, 2000);
      } catch {}
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.controllerOnline === false) connect();
    });

    log("NonZeroScript ready", P.id, state.sessionId);
  }

  boot();
})();
