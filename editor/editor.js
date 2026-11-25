// BB thread editor: file tree (with git badges), Monaco, metadata tree and
// static go-to-definition over the same XML export. Inline git-change gutter
// decorations come from the host's /bsl/git-diff route.
import * as React from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { useComposer } from "@get-bb/plugin-sdk/app";

const { useState, useEffect, useRef, useCallback } = React;
import { API_BASE, createEditorRequest } from "./protocol.js";
    
    // Colored folder + neutral file icons (rounded, 16×16). Folders are blue;
    // files are a single neutral color — the extension is already visible in the name.
    function coloredFolder(open) {
      const c = open ? "#6ab0ff" : "#3f8ef2";
      return jsx("svg", { width: 16, height: 16, viewBox: "0 0 16 16", children:
        jsx("path", { d: "M1.5 4.5A1.5 1.5 0 0 1 3 3h2.8c.4 0 .79.16 1.07.45l.72.7c.28.29.67.45 1.07.45H13A1.5 1.5 0 0 1 14.5 6V12a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12Z", fill: c })
      });
    }

    function coloredFile(name) {
      const c = "#8a94a6"; // single neutral color — extension is already visible in the name
      return jsxs("svg", { width: 16, height: 16, viewBox: "0 0 16 16", children: [
        jsx("path", { d: "M3 2h7l4 4v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 1.5 13V3.5A1.5 1.5 0 0 1 3 2Z", fill: c }),
        jsx("path", { d: "M10 2v4h4", fill: "none", stroke: "rgba(0,0,0,0.22)", strokeWidth: 1, strokeLinejoin: "round" }),
      ]});
    }

    // Сколько висит подсказка сверху, если человек её не закрыл. Дольше — мешает:
    // сообщение о результате человек читает один раз.
    const NOTICE_MS = 5000;
    // Сколько подсказка затухает, прежде чем её уберут с экрана. Тот же порядок,
    // что у появления: 200 мс — переход виден, но не задерживает.
    const NOTICE_FADE_MS = 200;
    // Сколько живёт сообщение поверх окна (отправка ссылки в чат).
    const TOAST_MS = 2200;

    // Подсказки повторяют тосты самого DSH (перенос чата в архив): тёмная
    // поверхность в обеих темах, крупный радиус, строка 14/22 и значок слева.
    // Геометрия значков — те же 16×16 глифы: круг с галочкой и круг с
    // восклицательным знаком.
    const NOTICE_GLYPH = {
      success: [
        { d: "M12.5303 6.53027L8.80273 10.2578C8.54967 10.5109 8.31796 10.7439 8.10645 10.9141C7.88375 11.0932 7.616 11.2602 7.27344 11.3145C7.09229 11.3431 6.90771 11.3431 6.72656 11.3145C6.384 11.2602 6.11625 11.0932 5.89355 10.9141C5.68204 10.7439 5.45033 10.5109 5.19727 10.2578L3.46973 8.53027L4.53027 7.46973L6.25781 9.19727C6.53457 9.47402 6.70036 9.63859 6.83398 9.74609C6.95637 9.84453 6.98241 9.83644 6.96094 9.83301C6.98679 9.83709 7.01321 9.83709 7.03906 9.83301C7.01759 9.83644 7.04363 9.84453 7.16602 9.74609C7.29964 9.63859 7.46543 9.47402 7.74219 9.19727L11.4697 5.46973L12.5303 6.53027Z", fill: "currentColor" },
        { d: "M14.5996 8C14.5996 4.35492 11.6451 1.40039 8 1.40039C4.35492 1.40039 1.40039 4.35492 1.40039 8C1.40039 11.6451 4.35492 14.5996 8 14.5996C11.6451 14.5996 14.5996 11.6451 14.5996 8ZM15.9004 8C15.9004 12.363 12.363 15.9004 8 15.9004C3.63695 15.9004 0.0996094 12.363 0.0996094 8C0.0996094 3.63695 3.63695 0.0996094 8 0.0996094C12.363 0.0996094 15.9004 3.63695 15.9004 8Z", fill: "currentColor" },
      ],
      warning: [
        { d: "M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z", stroke: "currentColor", fill: "none" },
        { d: "M8 4.29199V9.79199", stroke: "currentColor", fill: "none" },
        { d: "M8 10.708V11.708", stroke: "currentColor", fill: "none" },
      ],
    };

    // Одна таблица стилей на оба вида подсказки: плашку в редакторе и сообщение
    // поверх окна. Внешний вид держим вместе, чтобы они не разъезжались.
    const NOTICE_CSS = [
      // В редакторе: сверху, под полосой вкладок; клики по коду не перехватывает.
      ".bsl-notice{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:10;max-width:calc(100% - 24px);display:flex;justify-content:center;pointer-events:none}",
      // То же сообщение поверх окна — низ по центру.
      ".bsl-toast-float{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:flex;justify-content:center;pointer-events:none;max-width:min(640px,calc(100vw - 48px))}",
      // Поверхность тоста DSH: тёмная в обеих темах, радиус --dsw-radius-lg,
      // тень --dsw-shadow-lv3, одна строка 14/22.
      ".bsl-notice-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-toast-bg,#353638);color:var(--dsw-alias-toast-label,#fff);font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px;text-align:left;white-space:pre-wrap;box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 12px 32px rgba(0,0,0,.16));animation:bsl-notice-in .16s ease-out}",
      ".bsl-notice-text{min-width:0}",
      ".bsl-notice-icon{display:grid;place-items:center;flex:none;color:var(--dsw-alias-state-warn-label,#dd8629)}",
      ".bsl-notice-icon-success{color:var(--dsw-alias-state-success-primary,#22c55e)}",
      // Действие — синим текстом в строку, как в тосте DSH: на тёмной плашке
      // кнопка с фоном читается как второй интерфейс.
      ".bsl-notice-action{border:0;background:none;padding:0;margin-inline:3px;color:var(--dsw-static-deepseek-400,#7aaaff);font:inherit;line-height:inherit;cursor:pointer}",
      ".bsl-notice-action:hover{opacity:.8}",
      ".bsl-notice-close{flex:none;cursor:pointer;opacity:.55;padding:0 2px;line-height:1;transition:opacity .12s}",
      ".bsl-notice-close:hover{opacity:1}",
      ".bsl-notice-leaving .bsl-notice-pill{animation:bsl-notice-out .2s ease-in forwards}",
      "@keyframes bsl-notice-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}",
      "@keyframes bsl-notice-out{to{opacity:0;transform:translateY(-6px)}}",
      // Без движения: сдвиг убираем, затухание оставляем — иначе плашка исчезает
      // рывком и читается как сбой отрисовки.
      "@media (prefers-reduced-motion: reduce){.bsl-notice-pill{animation:bsl-notice-fade .16s ease-out}@keyframes bsl-notice-fade{from{opacity:0}to{opacity:1}}}",
    ].join("");

    function ensureNoticeCss() {
      if (document.querySelector("style[data-dsh-bsl-notice-css]")) return;
      const st = document.createElement("style");
      st.setAttribute("data-dsh-bsl-notice-css", "1");
      st.textContent = NOTICE_CSS;
      document.head.appendChild(st);
    }

    // Значок подсказки для обычного DOM (сообщение поверх окна).
    function noticeIconNode(tone) {
      const paths = NOTICE_GLYPH[tone];
      if (!paths) return null;
      const ns = "http://www.w3.org/2000/svg";
      const span = document.createElement("span");
      span.className = "bsl-notice-icon" + (tone === "success" ? " bsl-notice-icon-success" : "");
      span.setAttribute("aria-hidden", "true");
      const svg = document.createElementNS(ns, "svg");
      for (const [key, value] of Object.entries({ width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "stroke-width": "1" })) {
        svg.setAttribute(key, value);
      }
      for (const spec of paths) {
        const path = document.createElementNS(ns, "path");
        for (const [key, value] of Object.entries(spec)) path.setAttribute(key, value);
        svg.appendChild(path);
      }
      span.appendChild(svg);
      return span;
    }

    // Тот же значок для плашки, которую рисует React.
    function noticeIconElement(tone) {
      const paths = NOTICE_GLYPH[tone];
      if (!paths) return null;
      return jsx("span", {
        className: "bsl-notice-icon" + (tone === "success" ? " bsl-notice-icon-success" : ""),
        "aria-hidden": "true",
        children: jsx("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", strokeWidth: 1, children:
          paths.map((spec, i) => jsx("path", spec, i)),
        }),
      });
    }

    // Transient toast (fixed, bottom-centre) for editor actions.
    function showToast(msg) {
      ensureNoticeCss();
      let host = document.querySelector("[data-bsl-toast]");
      if (!host) {
        host = document.createElement("div");
        host.setAttribute("data-bsl-toast", "1");
        host.className = "bsl-toast-float";
        document.body.appendChild(host);
      }
      clearTimeout(host._timer);
      clearTimeout(host._fade);
      host.classList.remove("bsl-notice-leaving");
      const pill = document.createElement("span");
      pill.className = "bsl-notice-pill";
      const icon = noticeIconNode("success");
      if (icon) pill.appendChild(icon);
      const text = document.createElement("span");
      text.className = "bsl-notice-text";
      text.textContent = msg;
      pill.appendChild(text);
      // Свежий узел на каждое сообщение — плашка появляется заново, а не мигает
      // на месте прежней.
      host.textContent = "";
      host.appendChild(pill);
      host._timer = setTimeout(() => {
        host.classList.add("bsl-notice-leaving");
        host._fade = setTimeout(() => {
          host.classList.remove("bsl-notice-leaving");
          host.textContent = "";
        }, NOTICE_FADE_MS);
      }, TOAST_MS);
    }

    function sendToChat(composer, threadId, text) {
      try {
        if (composer.scope.kind !== "thread" || composer.scope.threadId !== threadId) throw new Error("Thread composer unavailable");
        composer.insert(text, { at: "end", block: true });
        composer.focus();
        showToast("Код добавлен к обсуждению");
      } catch (error) {
        console.warn("[bb-bsl-editor] composer insert failed:", error);
        showToast("Не удалось добавить код в композер");
      }
    }

    // Preserve Monaco's relative paths for its AMD loader and worker.
    const MONACO_BASE = API_BASE + "/vendor/vs";

    // Map a file path to a Monaco language id (for syntax highlighting).
    function langFor(path) {
      const ext = (path || "").slice(path.lastIndexOf(".")).toLowerCase();
      const m = {
        ".bsl": "bsl", ".os": "bsl",
        ".md": "markdown", ".markdown": "markdown",
        ".json": "json", ".xml": "xml", ".yml": "yaml", ".yaml": "yaml",
        ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
        ".py": "python", ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss",
        ".sh": "shell", ".sql": "sql", ".java": "java", ".cs": "csharp",
        ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c", ".cpp": "cpp", ".kt": "kotlin",
        ".ini": "ini", ".toml": "ini", ".bat": "bat",
      };
      return m[ext] || "plaintext";
    }

    // Причину называет хост — её надо прочитать и на ошибке: без этого на экране
    // оставалось голое «HTTP 400», по которому нельзя понять, что случилось
    // (нет git, папка не выгрузка 1С, файл не текстовый, в индексе пусто).
    async function errorFromResponse(res) {
      let body = null;
      try { body = await res.json(); } catch {}
      const err = new Error(String((body && (body.error || body.detail)) || ("HTTP " + res.status)));
      err.status = res.status;
      err.body = body;
      return err;
    }

    async function requestJson(request, url, opts) {
      const res = await request(url, opts);
      if (!res.ok) throw await errorFromResponse(res);
      return res.json();
    }

    // Identifier (with dotted module prefixes) under the cursor, e.g.
    // «АБСП_HTTPСервисЗапросы.ОбработатьЗапрос» for F12.
    function wordAt(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const left = line.slice(0, position.column - 1);
      const right = line.slice(position.column - 1);
      const ml = left.match(/[\wА-Яа-яЁё]+(?:\.[\wА-Яа-яЁё]+)*\.?$/);
      const mr = right.match(/^[\wА-Яа-яЁё]*/);
      const w = (ml ? ml[0] : "") + (mr ? mr[0] : "");
      return w.replace(/\.$/, "").trim() || null;
    }

    // ── Monaco (same-origin vendor) ───────────────────────────────────────
    // Some hosts (a sibling plugin bundle, an embedded webview, a bundler
    // polyfill) define globals that make monaco's AMD loader misdetect its
    // environment. The killer is `module`: monaco's env check is
    // `isNode = typeof module !== "undefined" && !!module.exports` — a page
    // with a global `module` object makes it take `module.exports = …`,
    // never installing its own `require` (window.require stays undefined and
    // `.config` crashes). A global `define` with `.amd` has a similar effect
    // (skips creating its loader). Neutralize them while the loader boots.
    let monacoPromise = null;
    function loadMonacoScript(url) {
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("не загрузился " + url));
        document.head.appendChild(script);
      });
    }

    function ensureMonaco() {
      if (monacoPromise) return monacoPromise;
      monacoPromise = (async () => {
        if (window.monaco) return window.monaco;
        const stashed = {};
        let ok = false;
        // Hand displaced globals back. `keepAmd` leaves monaco's own
        // require/define installed — the editor resolves modules through them
        // at runtime; on failure even they must go, or the host's `require`
        // stays replaced by monaco's loader.
        const restoreGlobals = (keepAmd) => {
          for (const k of Object.keys(stashed)) {
            if (keepAmd && (k === "require" || k === "define")) continue;
            try { window[k] = stashed[k]; } catch { /* non-writable global */ }
          }
        };
        try {
          for (const k of ["require", "define", "process", "module", "doNotInitLoader"]) {
            if (k in window) {
              stashed[k] = window[k];
              try { delete window[k]; } catch { /* non-configurable */ }
              // Globals declared with top-level `var` in injected scripts are
              // non-configurable — delete silently fails. Overwrite instead
              // (they are writable) so monaco's env detection sees nothing.
              try { window[k] = undefined; } catch { /* non-writable — leave it */ }
            }
          }
          // A previous attempt may have installed the AMD loader and failed
          // later (editor.main); injecting loader.js again would reset it.
          if (!(window.require && typeof window.require.config === "function")) {
            await loadMonacoScript(MONACO_BASE + "/loader.js");
          }
          // Give back everything except require/define — monaco's own must
          // stay installed until editor.main is done loading.
          restoreGlobals(true);
          if (typeof window.require !== "function") {
            throw new Error(
              "AMD require не установлен — process=" + typeof window.process +
              ", module=" + typeof window.module + ", define=" + typeof window.define,
            );
          }
          // Worker: same-origin vendor, чтобы воркеры не зависели от сети.
          // Внутри blob-воркера относительные URL не резолвятся — подставляем
          // полный origin. Monaco считает baseUrl родителем каталога `vs`.
          const origin = location.origin;
          window.MonacoEnvironment = {
            getWorkerUrl: () => URL.createObjectURL(new Blob(
              ["self.MonacoEnvironment={baseUrl:'" + origin + API_BASE + "/vendor/'};importScripts('" + origin + MONACO_BASE + "/base/worker/workerMain.js');"],
              { type: "text/javascript" })),
          };
          window.require.config({ paths: { vs: MONACO_BASE } });
          const monaco = await new Promise((resolve, reject) => {
            try {
              window.require(
                ["vs/editor/editor.main"],
                () => resolve(window.monaco),
                (err) => reject(err instanceof Error ? err : new Error(String(err || "AMD load failed"))),
              );
            } catch (e) {
              reject(e);
            }
          });
          if (!monaco) throw new Error("editor.main не инициализировал window.monaco");
          ok = true;
          restoreGlobals(true);
          return monaco;
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          throw new Error("Monaco из " + MONACO_BASE + ": " + detail);
        } finally {
          if (!ok) restoreGlobals(false);
        }
      })();
      // A failed attempt must not poison every later mount.
      monacoPromise.catch(() => { monacoPromise = null; });
      return monacoPromise;
    }

    // Official 1C TextMate grammar (the same one VS Code's 1C extension uses)
    // via monaco-textmate@3 + onigasm. The grammar JSON itself is served
    // same-origin by the host (/bsl/grammar/1c) — no runtime CDN dependency.
    // On any failure the hand-written Monarch grammar stays as the fallback.
    //
    // onigasm.loadWASM may run exactly ONCE per page, but the editor mounts
    // again on every session switch (DSH recreates the component), so the
    // whole TM stack (onigasm + grammar registry) is a module-level singleton:
    // the first wireTmGrammar call loads it, later calls reuse the loaded
    // grammar and only re-register the tokens provider on the new Monaco.
    let tmStackPromise = null;
    // onigasm's loadWASM is strictly once per page: its ESM module is cached
    // by the browser, so a RETRY after a partial failure would hit an already
    // initialized instance and throw "subsequent calls are not allowed",
    // poisoning every later mount. Keep this promise forever — only the
    // grammar/registry half of the stack is allowed to retry.
    let onigasmReadyPromise = null;
    function importVendor(file) {
      // TextMate imports this exact Onigasm URL and shares its initialized WASM.
      const url = API_BASE + "/vendor/" + file + "?v=2";
      return import(/* @vite-ignore */ url);
    }
    function getOnigasmReady() {
      if (!onigasmReadyPromise) {
        onigasmReadyPromise = (async () => {
          const onigasm = await importVendor("onigasm-esm.js");
          const response = await fetch(API_BASE + "/vendor/onigasm.wasm");
          if (!response.ok) throw new Error("onigasm.wasm недоступен");
          try {
            await onigasm.loadWASM(await response.arrayBuffer());
          } catch (e) {
            // Already initialized by a previous page-lifetime attempt — fine.
            if (!/subsequent calls|already/i.test(String(e?.message || e))) throw e;
          }
          return onigasm;
        })();
        // A failed attempt (wasm not reachable yet) may be retried later:
        // since "subsequent calls" is swallowed above, a retry can only hit
        // an uninitialized instance — safe to loadWASM again.
        onigasmReadyPromise.catch(() => { onigasmReadyPromise = null; });
      }
      return onigasmReadyPromise;
    }
    function getTmStack() {
      if (!tmStackPromise) {
        tmStackPromise = (async () => {
          const onigasm = await getOnigasmReady();
          const tm = await importVendor("monaco-textmate-esm.js");
          const [bslRes, queryRes] = await Promise.all([
            fetch(API_BASE + "/grammar/1c"),
            fetch(API_BASE + "/grammar/1c-query"),
          ]);
          if (!bslRes.ok) throw new Error("grammar HTTP " + bslRes.status);
          const grammarJson = await bslRes.json();
          const queryJson = queryRes.ok ? await queryRes.json() : null;
          // The BSL grammar references the 1C-query grammar by its official
          // scopeName ("source.sdbl" — a dependency for highlighting text-query
          // strings), so the locator must serve it; plus a minimal fallback for
          // any other unknown scope so the registry never hard-fails.
          const defs = new Map([[grammarJson.scopeName, { format: "json", content: grammarJson }]]);
          if (queryJson && queryJson.scopeName) defs.set(queryJson.scopeName, { format: "json", content: queryJson });
          const registry = new tm.Registry({
            getGrammarDefinition: async (scopeName) =>
              defs.get(scopeName) || { format: "json", content: { scopeName, patterns: [], repository: {} } },
          });
          const grammar = await registry.loadGrammar(grammarJson.scopeName);
          if (!grammar) throw new Error("grammar load failed");
          // Monaco 0.52 legacy provider shape: the tokenize result must carry
          // {startIndex, scopes} tokens (most specific TM scope) and an
          // endState that implements equals()/clone(); the adapter then matches
          // scopes against the active theme (bsl-dark tokenColors).
          class TokenizerState {
            constructor(ruleStack) { this._ruleStack = ruleStack; }
            get ruleStack() { return this._ruleStack; }
            clone() { return new TokenizerState(this._ruleStack); }
            equals(other) { return !!(other && other instanceof TokenizerState && other._ruleStack === this._ruleStack); }
          }
          return { tm, grammar, TokenizerState };
        })();
        // A later mount can retry a failed load.
        tmStackPromise.catch(() => { tmStackPromise = null; });
      }
      return tmStackPromise;
    }

    async function wireTmGrammar(monaco) {
      try {
        const { tm, grammar, TokenizerState } = await getTmStack();
        monaco.languages.setTokensProvider("bsl", {
          getInitialState: () => new TokenizerState(tm.INITIAL),
          tokenize: (line, state) => {
            const r = grammar.tokenizeLine(line, state.ruleStack);
            return {
              endState: new TokenizerState(r.ruleStack),
              tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: t.scopes[t.scopes.length - 1] })),
            };
          },
        });
      } catch (e) {
        console.error("[dsh-bsl-editor] tm grammar", e);
      }
    }

    function bslMonarch() {
      return {
        defaultToken: "",
        tokenPostfix: ".bsl",
        ignoreCase: true,
        keywords: [
          "Процедура", "КонецПроцедуры", "Функция", "КонецФункции",
          "Если", "Тогда", "ИначеЕсли", "Иначе", "КонецЕсли",
          "Для", "Каждого", "Из", "Пока", "По", "Цикл", "КонецЦикла",
          "Попытка", "Исключение", "КонецПопытки", "ВызватьИсключение",
          "Возврат", "Перем", "Новый", "Экспорт", "Знач", "Не", "И", "Или",
          "Продолжить", "Прервать", "Выполнить", "Истина", "Ложь", "Неопределено",
        ],
        typeKeywords: ["Структура", "Соответствие", "Массив", "СписокЗначений", "ТаблицаЗначений"],
        operators: ["+", "-", "*", "/", "%", "=", "<>", "<", ">", "<=", ">=", "?", ":", ".", ",", ";", "(", ")", "[", "]"],
        symbols: /[=><!~?:&|+\-*/^%]+/,
        tokenizer: {
          root: [
            [/^[ \t]*#.*$/, "keyword.control.preprocessor"],
            [/[#&](\w+)/, "annotation"],
            [/"([^"]|"")*"/, "string"],
            [/\b\d+(\.\d+)?\b/, "number"],
            [/\b(Процедура|Функция)\b/, "keyword"],
            [/\b([А-Яа-яЁёA-Za-z_][А-Яа-яЁёA-Za-z_0-9]*)\s*(?=\()/, "function"],
            [/\b(Если|Тогда|Иначе|ИначеЕсли|КонецЕсли|Для|Каждого|Пока|Цикл|КонецЦикла|Попытка|Исключение|КонецПопытки|Возврат|Перем|Экспорт|Знач|Продолжить|Прервать|Выполнить)\b/, "keyword"],
            [/[А-Яа-яЁёA-Za-z_][А-Яа-яЁёA-Za-z_0-9]*/, "identifier"],
            [/\/\/.*$/, "comment"],
            [/[{}]/, "@brackets"],
            [/[<>()\[\]]/, "@brackets"],
          ],
        },
      };
    }

    // ── Editor view component ──────────────────────────────────────────────
    // A fixed-size, non-shrinking slot for a row icon: SVG icons default to
    // flex-shrink:1 and, on deep rows with long names, get squeezed smaller than
    // their neighbours. Pin every icon to the same 16×16 centred box.
    const iconBox = (child) => jsx("span", {
      style: { display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 16, height: 16 },
      children: child,
    });

    // Editor state survives session switches: DSH remounts the conversation
    // view under key={sessionId} on every chat switch (component-local state
    // is destroyed by construction), so each session's UI state lives in a
    // module-level map keyed by sessionId and is snapshotted on unmount.
    const defaultPersist = () => ({
      mode: "files",
      children: new Map(),      // dirPath -> entries[]
      expanded: new Set(),      // expanded dirPaths
      rootPath: "",
      openPath: null,
      openContent: "",
      dirty: false,
      search: "",
      highlightPath: null,
      treeWidth: 280,
      gitFilter: null,          // null | "*" — null = все файлы, "*" = только изменённые
      tabs: [],                 // открытые вкладки (absolute paths, в порядке открытия)
      openBuffers: new Map(),   // path -> unsaved content (для табов с правками)
      metaChildren: new Map(),  // nodeKey -> items[]
      metaExpanded: new Set(),  // expanded nodeKeys
      metaInfo: null,
      metaError: "",
      metaHighlight: null,
      cursor: null,             // { lineNumber, column } — Monaco position
      scrollTop: 0,             // Monaco vertical scroll
      treeScrollTop: 0,         // file/metadata tree vertical scroll
    });
    const editorPersistBySession = new Map(); // sessionId -> persist snapshot

    // Канонический путь вкладок: обратные слеши → прямые, диск в верхний регистр.
    function normPath(p) {
      let s = String(p || "").replace(/\\/g, "/");
      if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
      return s;
    }

    // Короткий хеш содержимого изменения (FNV-1a): по нему изменение опознаётся между
    // перерисовками — номера строк при правках выше по файлу «плывут», а текст
    // изменения остаётся тем же.
    function hashChunk(s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36);
    }

    // Слияние отметок «просмотрено». Ответ сервера НЕ затирает то, что уже
    // отмечено здесь: запрос мог уйти раньше нашей записи отметки (запись —
    // «выстрелил и забыл»), и тогда принятый изменение возвращался в счётчик, а
    // следующая запись уносила на диск уже урезанный набор. Смена HEAD —
    // единственный законный сброс: сравнивать становится не с чем.
    function mergeReviewedHashes(prevHashes, prevHeadSha, serverHashes, serverHeadSha) {
      const merged = new Set(Array.isArray(serverHashes) ? serverHashes : []);
      if (serverHeadSha && prevHeadSha && serverHeadSha !== prevHeadSha) return merged;
      for (const id of prevHashes || []) merged.add(id);
      return merged;
    }

    // Русская форма слова при числе: 1 изменение, 2 изменения, 5 изменений.
    function pluralRu(n, one, few, many) {
      const n10 = n % 10;
      const n100 = n % 100;
      if (n10 === 1 && n100 !== 11) return one;
      if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
      return many;
    }
    const changesWord = (n) => pluralRu(n, "изменение", "изменения", "изменений");

    // Что сказать человеку про «В индекс». Слова здесь те же, что на экране:
    // «изменение» — блок правки, который отмечают кнопкой «Принять», «индекс» —
    // то, куда ведёт сама кнопка. Своих внутренних слов («изменение», «не совпало»)
    // в тексте нет: человек не знает, что так что-то называется внутри, и
    // читает их как вырванные из контекста.
    function stageReasonText(data) {
      const d = data || {};
      const parts = [];
      if (d.staged) parts.push(d.untracked ? "Новый файл добавлен в индекс целиком" : "В индекс отправлено " + d.staged + " " + changesWord(d.staged));
      if (d.inIndex) parts.push(d.staged ? "ещё " + d.inIndex + " " + changesWord(d.inIndex) + " были в индексе раньше" : d.inIndex + " " + changesWord(d.inIndex) + " уже в индексе");
      if (d.skipped) parts.push(d.skipped + " " + changesWord(d.skipped) + " отправить не удалось — файл правился после просмотра, обновите вид и отметьте их заново");
      if (parts.length) return parts.join("; ");
      if (d.reason === "no-marks") return "Нет просмотренных изменений — отметьте их кнопкой «Принять»";
      if (d.reason === "no-match") return "Отправлять нечего: изменений, которые вы отметили, в файле уже нет — обновите вид и отметьте заново";
      return "Отправлять нечего";
    }

    // То же для кнопки по всем изменённым файлам.
    function stageAllReasonText(data) {
      const d = data || {};
      if (Array.isArray(d.failed) && d.failed.length) return "Не удалось отправить: " + d.failed.join("; ");
      const parts = [];
      if (d.staged) parts.push("В индекс отправлено " + d.staged + " " + changesWord(d.staged));
      if (d.skipped) parts.push(d.skipped + " " + changesWord(d.skipped) + " отправить не удалось — файлы правились после просмотра, обновите вид");
      if (parts.length) return parts.join("; ");
      if (d.already && !d.noMarks) return "Все просмотренные изменения уже в индексе";
      if (d.noMarks) return "Нет просмотренных изменений — отметьте их кнопкой «Принять»";
      if (d.inIndex) return d.inIndex + " " + changesWord(d.inIndex) + " уже в индексе";
      if (d.noMatch) return "Просмотренные изменения отправить не удалось — файлы правились после просмотра, обновите вид";
      return "Отправлять нечего";
    }

    // Значок подсказки по итогу отправки в индекс: что-то легло в индекс —
    // галочка; иначе сообщение говорит, почему не вышло.
    function stageTone(data) {
      const d = data || {};
      return d.staged || d.already || d.inIndex ? "success" : "warning";
    }

    // Разбор unified diff на изменения. Каждый изменение знает: свой номер внутри
    // источника (для отката), строку «@@» (сверка перед откатом), строки новой
    // версии с добавленным текстом, блоки удалённых строк и хеш содержимого
    // (отметка «просмотрено»). source: "index" — изменение из индекса (git add),
    // "worktree" — из рабочей копии; откатываются они по-разному.
    function parseDiffHunks(diff, source) {
      const lines = String(diff || "").split("\n");
      // Дифф кончается переводом строки: в конце остаётся пустой «хвост». Если его
      // не отбросить, он прилипает к ПОСЛЕДНЕМУ изменению в файле — и у того же
      // изменения в другом диффе (там оно не последнее) отпечаток получается другим.
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const hunks = [];
      let cur = null;
      let index = -1;
      for (const l of lines) {
        if (l.startsWith("@@")) {
          const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
          if (!m) continue;
          index += 1;
          const newStart = parseInt(m[3], 10);
          cur = {
            source,
            index,
            header: l,
            newStart,
            newLine: newStart,
            added: [],        // текст добавленных строк
            addedLines: [],   // их номера в новой версии
            delRuns: [],      // [{ afterLine, lines[] }] — блоки удалённых строк
            // Тело изменения — строки БЕЗ заголовка «@@»: по нему считается
            // отпечаток отметки. Номера в заголовке у двух диффов разные (один
            // считается от индекса, другой от HEAD), поэтому отпечаток вместе с
            // заголовком не находил своё же изменение в индексе после отправки.
            text: [],
          };
          hunks.push(cur);
          continue;
        }
        if (!cur) continue;
        cur.text.push(l);
        if (l.startsWith("+")) {
          cur.addedLines.push(cur.newLine);
          cur.added.push(l.slice(1));
          cur.newLine += 1;
          cur.prevKind = "+";
        } else if (l.startsWith("-")) {
          // Подряд идущие удалённые строки — ОДИН блок: он рисуется одной
          // зоной, а разрыв блока даёт отдельную зону на своём месте.
          if (cur.prevKind !== "-") cur.delRuns.push({ afterLine: cur.newLine, lines: [] });
          cur.delRuns[cur.delRuns.length - 1].lines.push(l.slice(1));
          cur.prevKind = "-";
        } else if (l.startsWith(" ")) {
          cur.newLine += 1;
          cur.prevKind = " ";
        }
      }
      for (const h of hunks) {
        // Якорь изменения (кнопки и стрелки) — первая ИЗМЕНЁННАЯ строка: у изменения с
        // добавлениями это первая добавленная, у чистого удаления — строка под
        // красным блоком. Заголовок @@ отсчитывается от первой строки КОНТЕКСТА
        // (git даёт три), поэтому по нему якорь уводил на три строки выше.
        h.anchorLine = h.addedLines.length
          ? Math.min(...h.addedLines)
          : Math.max(1, h.delRuns.length ? h.delRuns[0].afterLine : h.newStart);
        // Хеш отметки — по СОДЕРЖИМОСТИ изменения, без источника: одна и та же
        // правка в индексе и в рабочей копии должна считаться одной и той же,
        // иначе после индексации она снова выглядит непросмотренной.
        h.id = hashChunk(h.delRuns.map((r) => r.lines.join("\n")).join("\u0001") + "\u0000" + h.added.join("\n"));
        // Тело изменения (без заголовка «@@») — по нему хост отбирает, что
        // уходит в индекс, и по нему же отмечает уже отправленное.
        h.text = h.text.join("\n");
      }
      return hunks;
    }

    // Раскладка кнопок «Отклонить/Принять» по вертикали. Правки, стоящие вплотную
    // (лишняя пустая строка, перенос строки из таба), дают по паре кнопок на каждую,
    // и пары наезжали друг на друга — это читается как сломанный интерфейс.
    // items: [{ top, h }] — желаемое место и высота кнопок каждого изменения.
    // Возвращает для каждого изменения итоговое место и признак «помещается в окно».
    // Функция чистая: её считает тест tests/_layout.mjs.
    function layoutHunkWidgets(items, viewH, gap = 2) {
      const order = items.map((it, i) => ({ i, top: it.top, h: it.h })).sort((a, b) => a.top - b.top || a.i - b.i);
      const out = new Array(items.length);
      let floor = -Infinity;
      for (const p of order) {
        const top = Math.max(p.top, floor);
        out[p.i] = { top, show: top >= 0 && top + p.h <= viewH - 1 };
        floor = top + p.h + gap;
      }
      return out;
    }

    function EditorView(props) {
      const { sessionId, request, composer, target } = props;
      const fetchJson = (url, options) => requestJson(request, url, options);
      const models = useRef(new Map()).current;
      const modelAuthority = React.useId().replace(/[^a-z0-9_-]/gi, "");
      let editorPersist = sessionId ? editorPersistBySession.get(sessionId) : null;
      if (!editorPersist) {
        editorPersist = defaultPersist();
        if (sessionId) editorPersistBySession.set(sessionId, editorPersist);
      }
      const [children, setChildren] = useState(() => new Map(editorPersist.children)); // dirPath -> entries[]
      const [expanded, setExpanded] = useState(() => new Set(editorPersist.expanded)); // expanded dirPaths
      const [rootPath, setRootPath] = useState(editorPersist.rootPath); // workspace root dir
      const [openPath, setOpenPath] = useState(editorPersist.openPath);
      const [openContent, setOpenContent] = useState(editorPersist.openContent);
      const [dirty, setDirty] = useState(editorPersist.dirty);
      const [saving, setSaving] = useState(false);
      const [saveError, setSaveError] = useState("");
      const [gitFiles, setGitFiles] = useState(new Map());
      // Почему список изменений пуст: "no-git" | "no-repo" | "status-failed" | "".
      // Без этого пустой список читается как «изменений нет», хотя git может
      // быть просто не найден.
      const [gitWhy, setGitWhy] = useState("");
      const [gitLoading, setGitLoading] = useState(false); // читаем список изменений
      const [gitDetail, setGitDetail] = useState(""); // что сказал сам git
      const [gitInitBusy, setGitInitBusy] = useState(false);
      const [gitInitError, setGitInitError] = useState("");
      const [rootTitle, setRootTitle] = useState("");
      const [treeError, setTreeError] = useState("");
      const [loadingDirs, setLoadingDirs] = useState(() => new Set()); // какие каталоги читаются прямо сейчас
      const [refreshBusy, setRefreshBusy] = useState(false); // идёт «Обновить дерево»
      const [monacoReady, setMonacoReady] = useState(false);
      const [search, setSearch] = useState(editorPersist.search);
      const [searchResults, setSearchResults] = useState([]);
      const [highlightPath, setHighlightPath] = useState(editorPersist.highlightPath);
      const [treeWidth, setTreeWidth] = useState(editorPersist.treeWidth);
      const [gitFilter, setGitFilter] = useState(editorPersist.gitFilter);
      const [tabs, setTabs] = useState(editorPersist.tabs);

      // Metadata-tree mode: "files" (fs tree) | "meta" (1C metadata tree).
      const [mode, setMode] = useState(editorPersist.mode);
      const [metaChildren, setMetaChildren] = useState(() => new Map(editorPersist.metaChildren)); // nodeKey -> items[]
      const [metaExpanded, setMetaExpanded] = useState(() => new Set(editorPersist.metaExpanded)); // expanded nodeKeys
      const [metaInfo, setMetaInfo] = useState(editorPersist.metaInfo); // /bsl/meta/status result
      const [metaError, setMetaError] = useState(editorPersist.metaError);
      const [metaLoadingKey, setMetaLoadingKey] = useState(null); // какой узел метаданных читается
      const [metaLoading, setMetaLoading] = useState(false);
      const [metaHighlight, setMetaHighlight] = useState(editorPersist.metaHighlight);
      const [editorNotice, setEditorNotice] = useState(null); // transient banner over the editor
      const [noticeSticky, setNoticeSticky] = useState(false); // у плашки есть кнопка действия
      const [noticeTone, setNoticeTone] = useState(null); // значок: success | warning | без значка
      const [noticeLeaving, setNoticeLeaving] = useState(false); // плашка затухает перед уборкой
      // Подсказка сверху гаснет сама: плашка, которая висит, пока её не сменит
      // следующее действие, читается как поломка («ошибка появилась и висит не
      // уходя»). Не гаснет только карточка с кнопкой — она ждёт решения человека.
      // И появление, и исчезновение — с переходом: рывок на экране читается как
      // сбой отрисовки.
      const noticeTimerRef = useRef(null); // авто-скрытие
      const noticeFadeRef = useRef(null); // затухание перед уборкой
      const fadeNoticeOut = useCallback(() => {
        if (noticeFadeRef.current) clearTimeout(noticeFadeRef.current);
        setNoticeLeaving(true);
        noticeFadeRef.current = setTimeout(() => {
          noticeFadeRef.current = null;
          setEditorNotice(null);
          setNoticeLeaving(false);
        }, NOTICE_FADE_MS);
      }, []);
      // sticky — сообщение, которое гаснет только по решению человека (у него
      // есть кнопка действия: «Перезагрузить с диска»).
      // tone — значок слева, как в тосте DSH: success (сделано) или warning
      // (что-то не вышло / нечего делать). Без tone плашка остаётся текстом.
      const showNotice = useCallback((text, sticky = false, tone = null) => {
        if (noticeTimerRef.current) {
          clearTimeout(noticeTimerRef.current);
          noticeTimerRef.current = null;
        }
        if (noticeFadeRef.current) {
          clearTimeout(noticeFadeRef.current);
          noticeFadeRef.current = null;
        }
        setNoticeLeaving(false); // новое сообщение отменяет затухание прежнего
        setEditorNotice(text || null);
        setNoticeSticky(!!text && !!sticky);
        setNoticeTone(text ? tone : null);
        if (!text || sticky) return;
        noticeTimerRef.current = setTimeout(() => {
          noticeTimerRef.current = null;
          fadeNoticeOut();
        }, NOTICE_MS);
      }, [fadeNoticeOut]);
      const closeNotice = useCallback(() => {
        externalReloadRef.current = null;
        if (noticeTimerRef.current) {
          clearTimeout(noticeTimerRef.current);
          noticeTimerRef.current = null;
        }
        fadeNoticeOut();
      }, [fadeNoticeOut]);
      useEffect(() => () => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        if (noticeFadeRef.current) clearTimeout(noticeFadeRef.current);
      }, []);
      const [ctxMenu, setCtxMenu] = useState(null); // { x, y, item } — meta-tree context menu
      const [monacoError, setMonacoError] = useState(""); // editor load failure, shown in the placeholder
      const [cfg, setCfg] = useState(null); // /bsl/config result (plugin settings)

      const joinPath = (parent, name) => parent + (parent.endsWith("/") || parent.endsWith("\\") ? "" : "\\") + name;

      const editorRef = useRef(null);
      const monacoRef = useRef(null);
      const modelRef = useRef(null);
      const dirtySubRef = useRef(null); // monaco model onDidChangeContent subscription
      const containerRef = useRef(null);
      const addedDecoIdsRef = useRef([]);
      const diffZoneIdsRef = useRef([]);
      const rootRef = useRef(null);
      const treeBodyRef = useRef(null);
      const draggingRef = useRef(false);
      const rootPathRef = useRef("");
      const openPathRef = useRef(editorPersist.openPath || "");
      const mouseInEditorRef = useRef(false);
      // Своё контекстное меню в редакторе: встроенное английское, а команды и
      // подсказки в остальном окне — русские.
      const [codeMenu, setCodeMenu] = useState(null);
      const staticNavRef = useRef(null); // { word, targets, index } for F12 cycling
      const f12BoundRef = useRef(null); // editor.addCommand id — bind F12 once
      const diffNavRef = useRef({ anchors: [], index: -1 }); // якоря изменений + текущий индекс (вне useState — без ререндеров)
      const diffWidgetRef = useRef(null); // overlay-виджет навигации { dom, label }
      const navigateDiffRef = useRef(null);
      // Изменения диффа открытого файла — сырьё для вида: «принять»/«отклонить»
      // перерисовывают вид отсюда, без нового запроса к git.
      const diffHunksRef = useRef([]);
      // Отметки «просмотрено»: headSha + хеши принятых изменений + показывать ли
      // их (по умолчанию скрыты — в файле видно только непросмотренное).
      const reviewedRef = useRef({ headSha: "", hashes: new Set(), show: false });
      const hunkWidgetsRef = useRef([]); // overlay-виджеты «Отклонить/Принять» по изменениям
      // Пока запрос к хосту в пути, кнопки изменений выключены: нажатие вторым
      // порядком отправляло устаревший номер изменения, хост отвечал «файл
      // изменился — обновите вид», и это читалось как сломанный интерфейс.
      const hunkBusyRef = useRef(false);
      const placeHunkWidgetsRef = useRef(null); // расстановка этих кнопок по строкам
      const acceptHunkRef = useRef(null);
      const rejectHunkRef = useRef(null);
      const resetDiffViewRef = useRef(null); // снять вид диффа (и шапку) — зовётся при закрытии файла
      const rejectAllTimerRef = useRef(null); // сброс «подтверждения» для «Отклонить все»
      const rejectAllArmedRef = useRef(false); // первый клик по «Отклонить все» уже сделан
      const [diffState, setDiffState] = useState({ total: 0, unresolved: 0, reviewed: 0, show: false });
      const [commitOpen, setCommitOpen] = useState(false);
      const [commitMsg, setCommitMsg] = useState("");
      const [commitBusy, setCommitBusy] = useState(false);
      const [commitError, setCommitError] = useState("");
      const [commitFiles, setCommitFiles] = useState([]);
      const [stageAllBusy, setStageAllBusy] = useState(false);
      const [rejectAllArmed, setRejectAllArmed] = useState(false);
      useEffect(() => { rootPathRef.current = rootPath; }, [rootPath]);
      useEffect(() => { openPathRef.current = openPath; }, [openPath]);
      const dirtyRef = useRef(false);
      useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

      // Mirror the whole UI state into editorPersist so an unmount/remount
      // (session switch) restores exactly where the user left off.
      useEffect(() => {
        editorPersist.mode = mode;
        editorPersist.children = children;
        editorPersist.expanded = expanded;
        editorPersist.rootPath = rootPath;
        editorPersist.openPath = openPath;
        // Keep the buffer only when there are unsaved edits — otherwise the
        // file is re-read from disk on restore, and we don't hold a stale
        // copy of every visited file in memory.
        editorPersist.openContent = dirty ? openContent : "";
        editorPersist.dirty = dirty;
        editorPersist.search = search;
        editorPersist.highlightPath = highlightPath;
        editorPersist.treeWidth = treeWidth;
        editorPersist.gitFilter = gitFilter;
        // Tabs + per-tab dirty buffers survive session switches.
        editorPersist.tabs = tabs;
        editorPersist.openBuffers = openBuffersRef.current;
        editorPersist.metaChildren = metaChildren;
        editorPersist.metaExpanded = metaExpanded;
        editorPersist.metaInfo = metaInfo;
        editorPersist.metaError = metaError;
        editorPersist.metaHighlight = metaHighlight;
      }, [mode, children, expanded, rootPath, openPath, openContent, dirty, search, highlightPath, treeWidth, gitFilter, metaChildren, metaExpanded, metaInfo, metaError, metaHighlight]);

      // Snapshot the Monaco caret + scroll position at unmount time. This
      // effect's cleanup runs BEFORE the Monaco effect's cleanup (declared
      // earlier), so the editor instance is still alive when we read it.
      useEffect(() => {
        return () => {
          const ed = editorRef.current;
          if (ed && typeof ed.isDisposed === "function" && !ed.isDisposed()) {
            const pos = ed.getPosition();
            if (pos) editorPersist.cursor = { lineNumber: pos.lineNumber, column: pos.column };
            editorPersist.scrollTop = ed.getScrollTop() || 0;
          }
          const treeBody = treeBodyRef.current;
          if (treeBody) editorPersist.treeScrollTop = treeBody.scrollTop || 0;
        };
      }, []);

      // Заголовок рабочей папки берём отдельно: он нужен первому экрану,
      // works as a file browser + Monaco (syntax highlighting) on its own.
      useEffect(() => {
        if (!document.querySelector("style[data-dsh-bsl-tree-css]")) {
          const st = document.createElement("style");
          st.setAttribute("data-dsh-bsl-tree-css", "1");
          st.textContent = ".dsh-bsl-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-bsl-resizer{background:transparent;transition:background .12s}.dsh-bsl-resizer:hover{background:var(--dsw-alias-state-business-primary)}.dsh-bsl-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}"
            + ".bsl-git-added-line{background:rgba(46,160,67,.15);box-shadow:inset 2px 0 0 rgba(46,160,67,.4)}"
            + ".bsl-git-del-zone{background:rgba(248,81,73,.12);overflow:hidden}"
            + ".bsl-git-del-line{color:#f88f8a;font-family:var(--monaco-monospace-font,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:14px;line-height:20px;white-space:pre;text-overflow:clip;overflow:hidden}"
            // Принятый (просмотренный) изменение — приглушённый серый: подсветка не
            // мозолит глаза, но правку ещё видно.
            + ".bsl-git-reviewed-line{background:rgba(138,148,166,.13);box-shadow:inset 2px 0 0 rgba(138,148,166,.35)}"
            + ".bsl-git-reviewed-zone{background:rgba(138,148,166,.10)}"
            + ".bsl-git-reviewed-zone .bsl-git-del-line{color:#9aa3b2}"
            // Кнопки у изменения — overlay-виджеты: по горизонтали прижимаются
            // вправо (за вычетом миникарты, её ширину плагин кладёт в
            // --bsl-hunk-right), по вертикали их ставит placeHunkWidgets.
            + ".bsl-hunk-actions{position:absolute;left:auto!important;right:var(--bsl-hunk-right,26px)!important;display:inline-flex;align-items:center;gap:6px;padding-bottom:3px;pointer-events:auto}"
            + ".bsl-hunk-btn{font-family:var(--dsw-font-family,inherit);font-size:12px;font-weight:500;line-height:18px;height:20px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-2,#22242a);color:var(--dsw-alias-label-secondary,#8a94a6);cursor:pointer;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.25)}"
            + ".bsl-hunk-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
            + ".bsl-hunk-btn--reject:hover{background:rgba(248,81,73,.18);border-color:rgba(248,81,73,.55);color:#f88f8a}"
            + ".bsl-hunk-btn--accept:hover{background:rgba(46,160,67,.18);border-color:rgba(46,160,67,.55);color:#7ee2a8}"
            + ".bsl-hunk-btn--armed{background:rgba(248,81,73,.22)!important;border-color:rgba(248,81,73,.6)!important;color:#f88f8a!important}"
            + ".bsl-git-flash{animation:bsl-git-flash-kf .6s ease-out}@keyframes bsl-git-flash-kf{from{background:rgba(255,220,90,.35)}to{background:transparent}}"
            // Ожидание чтения: на большой выгрузке папка открывается секундами,
            // и без индикатора клик выглядел как «ничего не произошло».
            + "@keyframes bsl-spin-kf{to{transform:rotate(360deg)}}"
            + ".bsl-spin{animation:bsl-spin-kf .8s linear infinite}"
            + ".bsl-spinner{display:inline-block;flex-shrink:0;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;opacity:.7;animation:bsl-spin-kf .8s linear infinite}"
            + ".bsl-loading{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;opacity:.65}"
            // Плашка MCP-менеджера (чужой плагин, классы dm-*) висит в том же
            // правом верхнем углу, где стоят кнопки файла, и закрывает их.
            // Сдвигаем плашку ниже полосы вкладок: своей настройкой плагин
            // положение не сохраняет. Панель двигаем вместе с плашкой, иначе
            // они разъезжаются.
            + ".bsl-hunk-btn:disabled{opacity:.5;cursor:default}"
            + ".bsl-commit-box{display:flex;flex-direction:column;gap:6px;margin:0 4px 8px;padding:8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#22242a)}"
            + ".bsl-commit-list{max-height:110px;overflow:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#8a94a6)}"
            + ".bsl-commit-row{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
            + ".bsl-commit-msg{box-sizing:border-box;width:100%;min-height:54px;resize:vertical;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-1,#1b1d22);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.4}"
            + ".bsl-commit-error{font-size:12px;color:#f44336}"
            + ".bsl-commit-note{font-size:12px;color:var(--dsw-alias-label-secondary,#8a94a6)}"
            // Иконки метаданных нарисованы светлыми глифами (#F0EFF1 на #656565):
            // на тёмном фоне читаются, на светлом сливаются с ним. Инверсия
            // яркости держит их контраст (#313131 на #929292) и не трогает
            // тёмную тему.
            + "body:not([data-ds-dark-theme]) .bsl-meta-icon{filter:invert(.85)}"
            + ".dm-float,.dm-float-panel{top:84px!important}";
          document.head.appendChild(st);
          // Подсказки — своей таблицей стилей: их рисуют обе половины (React в
          // редакторе и обычный DOM поверх окна), правила должны быть одни.
          ensureNoticeCss();
        }
        let alive = true;
        (async () => {
          try {
            const ws = await fetchJson(API_BASE + "/workspaces");
            if (alive && ws.title) setRootTitle(ws.title);
          } catch {}
        })();
        return () => { alive = false; };
      }, []);

      // Plugin settings exposed by BB and relayed by the host.
      useEffect(() => {
        let alive = true;
        fetchJson(API_BASE + "/config")
          .then((c) => { if (alive) setCfg(c); })
          .catch(() => {
            if (alive) setCfg({ sourceExtensions: [".bsl", ".os"], workspaceDir: "" });
          });
        return () => { alive = false; };
      }, []);


      // create the Monaco editor once
      useEffect(() => {
        let alive = true;
        let disposeEditor;
        ensureMonaco().then((monaco) => {
          if (!alive || !containerRef.current) return;
          monacoRef.current = monaco;
          monaco.languages.register({ id: "bsl" });
          monaco.languages.setMonarchTokensProvider("bsl", bslMonarch());
          monaco.languages.setLanguageConfiguration("bsl", { comments: { lineComment: "//" } });
          try {
            monaco.editor.defineTheme("bsl-dark", {
              base: "vs-dark",
              inherit: true,
              rules: [
                { token: "keyword", foreground: "F92672" },
                { token: "keyword.operator", foreground: "F92672" },
                { token: "keyword.other.preprocessor", foreground: "F92672" },
                { token: "storage.type", foreground: "66D9EF", fontStyle: "italic" },
                { token: "storage.modifier", foreground: "F92672" },
                { token: "support.function", foreground: "66D9EF" },
                { token: "support.class", foreground: "66D9EF" },
                { token: "entity.name.function", foreground: "A6E22E" },
                { token: "entity.name.section", foreground: "A6E22E" },
                { token: "string.quoted.double", foreground: "E6DB74" },
                { token: "constant.numeric", foreground: "AE81FF" },
                { token: "constant.language", foreground: "AE81FF" },
                { token: "comment", foreground: "88846F", fontStyle: "italic" },
                { token: "variable", foreground: "F8F8F2" },
                { token: "invalid", foreground: "F44747" },
              ],
              // Monokai (VS Code theme-monokai) editor surface colors. The
              // field must exist even when inheriting everything from the base
              // theme (missing colors = crash on editor.create in 0.52+).
              colors: {
                "editor.background": "#272822",
                "editor.foreground": "#F8F8F2",
                "editorLineNumber.foreground": "#90908A",
                "editorCursor.foreground": "#F8F8F0",
                "editor.selectionBackground": "#878B9180",
                "editor.lineHighlightBackground": "#3E3D32",
                "editorWhitespace.foreground": "#464741",
                "editorIndentGuide.background": "#464741",
                "editorIndentGuide.activeBackground": "#767771",
                "editorGutter.background": "#272822",
              },
            });
          } catch {}
          const composerClearance = (() => {
            try {
              const v = getComputedStyle(document.documentElement).getPropertyValue("--dsh-composer-height").trim();
              const n = parseInt(v, 10);
              return (Number.isFinite(n) && n > 0 ? n : 152) + 16;
            } catch { return 168; }
          })();
          const editor = monaco.editor.create(containerRef.current, {
            value: "",
            language: "bsl",
            theme: "bsl-dark",
            automaticLayout: true,
            // Встроенное меню английское — показываем своё.
            contextmenu: false,
            minimap: { enabled: true },
            fontSize: 14,
            scrollBeyondLastLine: false,
            padding: { top: 0, bottom: composerClearance },
            // Кириллица в русском BSL-коде для Monaco — «ambiguous unicode»
            // (А/В/С/Е/О/Р похожи на латинские) и «non-basic ASCII», поэтому над
            // редактором висит баннер на каждом файле с русскими комментариями и
            // строками запросов. Обе проверки выключаем. Подсветку невидимых
            // символов (неразрывный пробел, zero-width) оставляем включённой:
            // в 1С они действительно ломают код и ищутся глазами плохо.
            // Опция принимается ТОЛЬКО вложенным объектом (IUnicodeHighlightOptions
            // из monaco.d.ts): плоские ключи вида "unicodeHighlight.ambiguousCharacters"
            // валидатор опций молча игнорирует, и баннер остаётся.
            unicodeHighlight: {
              ambiguousCharacters: false,
              nonBasicASCII: false,
              invisibleCharacters: true,
            },
          });
          editorRef.current = editor;
          if (alive) setMonacoReady(true);
          // No file selected yet: detach the empty model and show a hint
          // instead of a lonely first line.
          if (!openPathRef.current) {
            editor.setModel(null);
            showNotice("Выберите файл из дерева", false, "warning");
          }
          // Official 1C TextMate grammar replaces the Monarch fallback once
          // the TM stack is ready (best-effort, never blocks the editor).
          wireTmGrammar(monaco);

          // Context-menu action: put the module path on the clipboard. The path
          // is relative to the project root, which is what the analysis panel
          // (and its «Проверить» field) resolves against.
          editor.addAction({
            id: "bsl-copy-path",
            label: "Скопировать путь модуля",
            contextMenuGroupId: "9_cutcopypaste",
            contextMenuOrder: 1.4,
            run: async (ed) => {
              const model = ed.getModel();
              if (!model) return;
              const full = model.uri.path.slice(1).replace(/^\/+/, "");
              const root = (rootPathRef.current || "").replace(/\\/g, "/").replace(/^\/+/, "");
              const rel =
                root && full.toLowerCase().startsWith(root.toLowerCase())
                  ? full.slice(root.length).replace(/^\/+/, "")
                  : full;
              try {
                await navigator.clipboard.writeText(rel);
                showNotice("Путь скопирован: " + rel, false, "success");
              } catch {
                showNotice("Буфер обмена недоступен", false, "warning");
              }
            },
          });

          // Context-menu action: reference the current selection in the chat.
          editor.addAction({
            id: "bsl-ref-to-chat",
            label: "Добавить к обсуждению",
            contextMenuGroupId: "9_cutcopypaste",
            contextMenuOrder: 1.5,
            precondition: "editorHasSelection",
            run: (ed) => {
              const sel = ed.getSelection();
              const model = ed.getModel();
              if (!sel || sel.isEmpty() || !model) return;
              const full = (openPathRef.current || "").replace(/^\/+/, "");
              let rel = full;
              const r = (rootPathRef.current || "").replace(/\\/g, "/").replace(/^\/+/, "");
              if (r && rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length).replace(/^\/+/, "");
              const a = sel.startLineNumber, b = sel.endLineNumber;
              const ref = rel + (a === b ? ":" + a : ":" + a + "-" + b);
              sendToChat(composer, props.threadId, ref);
            },
          });

          // Ctrl+A (и другие хоткеи с модификатором): когда мышь над областью
          // редактора, но фокус в дереве/поиске — отправлять команду в Monaco,
          // а не в DSH (иначе Ctrl+A выделяет всю страницу).
          const editorHost = containerRef.current;
          const onEditorEnter = () => { mouseInEditorRef.current = true; };
          const onEditorLeave = () => { mouseInEditorRef.current = false; };
          editorHost.addEventListener("mouseenter", onEditorEnter);
          editorHost.addEventListener("mouseleave", onEditorLeave);
          const onGlobalKey = (e) => {
            if (!mouseInEditorRef.current) return;
            const k = e.key.toLowerCase();
            if (!(e.ctrlKey || e.metaKey) || (k !== "a" && k !== "s")) return;
            if (editorHost.contains(document.activeElement)) return; // фокус уже в Monaco
            e.preventDefault();
            e.stopPropagation();
            if (k === "a") {
              const ed = editorRef.current;
              if (!ed) return;
              ed.focus();
              ed.trigger("keyboard", "editor.action.selectAll", null);
            } else {
              saveFileRef.current?.();
            }
          };
          window.addEventListener("keydown", onGlobalKey, true);
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFileRef.current?.());
          editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.ArrowDown, () => navigateDiffRef.current?.(1));
          editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.ArrowUp, () => navigateDiffRef.current?.(-1));

          // Keep the persisted caret/scroll fresh in real time, not just at
          // unmount: view switches inside a session (Editor ↔ Chat) tear the
          // component down through a path where unmount cleanup can be missed,
          // so the snapshot must already be current when that happens.
          const scrollSub = editor.onDidScrollChange((e) => { editorPersist.scrollTop = e.scrollTop || 0; });
          // Скролл/клик по файлу: актуализировать счётчик дифф-навигатора
          // (ближайший якорь выше центра видимой области). Не во время
          // программного перехода (gotoAnchor сам ставит index).
          let syncingNav = false;
          const syncNavSub = editor.onDidScrollChange(() => {
            if (syncingNav) return;
            syncingNav = true;
            try { syncDiffNavRef.current?.(); placeHunkWidgetsRef.current?.(); } finally { syncingNav = false; }
          });
          // Кнопки изменений держатся за строку сами (overlay-виджет строки не
          // знает), поэтому их надо переставлять и при смене размеров редактора.
          const layoutSub = editor.onDidLayoutChange(() => { placeHunkWidgetsRef.current?.(); });
          const cursorSub = editor.onDidChangeCursorPosition((e) => {
            editorPersist.cursor = { lineNumber: e.position.lineNumber, column: e.position.column };
          });

          disposeEditor = () => {
            scrollSub.dispose();
            syncNavSub.dispose();
            layoutSub.dispose();
            cursorSub.dispose();
            dirtySubRef.current?.dispose();
            editorRef.current = null;
            editor.dispose();
            editorHost.removeEventListener("mouseenter", onEditorEnter);
            editorHost.removeEventListener("mouseleave", onEditorLeave);
            window.removeEventListener("keydown", onGlobalKey, true);
            for (const model of models.values()) model.dispose();
            models.clear();
          };
        }).catch((e) => {
          console.error("[dsh-bsl-editor] monaco", e);
          if (alive) setMonacoError(String(e?.message || e));
        });
        return () => {
          alive = false;
          disposeEditor?.();
        };
      }, []);

      // Layout: the editor root sets `data-conversation-composer-overlay` (same
      // mechanism as the Trajectory view). DSH then bounds the view area with
      // `flex:1 1 0; min-height:0; overflow:hidden` and floats the composer over
      // the bottom with a fade gradient — so we don't pin our own height; the tree
      // and Monaco just need bottom clearance to scroll above the composer.

      const loadDir = useCallback(async (path) => {
        const key = path || "";
        setLoadingDirs((prev) => { const s = new Set(prev); s.add(key); return s; });
        try {
          const data = await fetchJson(API_BASE + "/tree?path=" + encodeURIComponent(path || ""));
          const dir = data.path;
          setRootPath((prev) => prev || data.root || dir);
          setChildren((prev) => { const m = new Map(prev); m.set(dir, data.entries); return m; });
          setTreeError("");
          return dir;
        } catch (e) {
          setTreeError(e?.message || String(e));
          return null;
        } finally {
          setLoadingDirs((prev) => { const s = new Set(prev); s.delete(key); return s; });
        }
      }, []);

      const toggle = useCallback(async (dirPath) => {
        if (expanded.has(dirPath)) {
          setExpanded((prev) => { const s = new Set(prev); s.delete(dirPath); return s; });
        } else {
          setExpanded((prev) => new Set(prev).add(dirPath));
          if (!children.has(dirPath)) await loadDir(dirPath);
        }
      }, [expanded, children, loadDir]);

      // Зеркало gitFiles для кода вне React-рендера (разметка диффа и
      // распознавание «файл ещё не в git»).
      const gitFilesRef = useRef(new Map());
      const refreshGit = useCallback(async (fresh = false) => {
        setGitLoading(true);
        try {
          // fresh=true — из кнопки «Обновить дерево»: кэш статусов на хосте
          // сбрасывается, иначе список изменённых пятисекундной давности.
          const data = await fetchJson(API_BASE + "/git-status" + (fresh ? "?fresh=1" : ""));
          setGitWhy(data.ok ? "" : String(data.reason || ""));
          setGitDetail(data.ok ? "" : String(data.detail || ""));
          if (data.ok) {
            const m = new Map();
            for (const f of data.files) m.set(f.path, f.status);
            gitFilesRef.current = m;
            setGitFiles(m);
          }
        } catch (e) {
          // Хост отвечает 200 с причиной; 400/500 приходит исключением, но и в нём
          // есть reason/detail — иначе список молча показывал «Нет изменённых файлов».
          const body = e && e.body;
          setGitWhy(String((body && body.reason) || ""));
          setGitDetail(String((body && (body.detail || body.error)) || (e && e.message) || e || ""));
        } finally {
          setGitLoading(false);
        }
      }, []);

      // ── Tabs: multiple open files, per-tab unsaved buffers ──────────────
      // Monaco models hold each file's content (and unsaved edits) under a
      // stable URI, so switching tabs is just editor.setModel() — buffers
      // survive both tab switches and session switches. openBuffersRef
      // mirrors which tabs are dirty and keeps their text for persistence.
      const openBuffersRef = useRef(editorPersist.openBuffers instanceof Map ? editorPersist.openBuffers : new Map()); // path -> unsaved content
      const [tabDirty, setTabDirty] = useState(() => new Set(openBuffersRef.current.keys()));
      const markTabDirty = useCallback((path, isDirty, content) => {
        if (isDirty) openBuffersRef.current.set(path, content);
        else openBuffersRef.current.delete(path);
        setTabDirty((prev) => { const s = new Set(prev); isDirty ? s.add(path) : s.delete(path); return s; });
      }, []);
      // Tabs are keyed by a canonical absolute path: forward slashes, drive
      // letter upper-cased. The same file reached via tree (backslashes),
      // search results or the git list must land on ONE tab, and `openPath`
      // (the server's normalized path) must equal that key for highlighting.
      const addTab = useCallback((raw) => {
        const path = normPath(raw);
        setTabs((prev) => prev.includes(path) ? prev : [...prev, path]);
        return path;
      }, []);

      // Per-tab Monaco view state (scroll + cursor): saved on leave, restored
      // on return — switching tabs must feel like switching browser tabs.
      const viewStatesRef = useRef(new Map()); // normPath -> monaco view state

      // mtime на диске на момент загрузки модели — для hot-reload вкладок.
      const modelMtimesRef = useRef(new Map()); // normPath -> mtimeMs
      // Флаг BOM файла (UTF-8 с BOM у 1С): запоминается при чтении и
      // передаётся в /bsl/write, чтобы сохранить кодировку файла.
      const bomRef = useRef(new Map()); // normPath -> bool
      // Кодировка файла при чтении (utf-8 | windows-1251) — передаётся в
      // /bsl/write, чтобы cp1251-файлы 1С не портились при пересохранении.
      const encRef = useRef(new Map()); // normPath -> string
      // Программная навигация (F12) сама ставит позицию — view-state
      // восстанавливать не нужно (он перекрыл бы целевой переход).
      const suppressViewRestoreRef = useRef(false);
      // Путь файла, ожидающего автопереход к первому диффу после открытия.
      const freshOpenPathRef = useRef(null);
      const gotoAnchorRef = useRef(null);
      const syncDiffNavRef = useRef(null);

      // Файл изменился извне (агент/внешний редактор): чистый буфер тихо
      // перечитываем, грязный — баннер с кнопкой перезагрузки.
      // refreshGitDecorations объявлен ниже (TDZ) — доступ через ref.
      const refreshGitDecorationsRef = useRef(null);
      const checkExternalChange = useCallback(async (fullPath, model) => {
        const known = modelMtimesRef.current.get(fullPath);
        let disk;
        try {
          disk = await fetchJson(API_BASE + "/stat?path=" + encodeURIComponent(fullPath));
        } catch { return; }
        const mtime = disk.mtimeMs ?? null;
        if (mtime == null) return;
        if (known != null && Math.abs(mtime - known) < 1) return;
        // known == null — refs пересозданы ремоунтом EditorView; модель жива,
        // но база для сравнения утрачена. Сверяем КОНТЕНТ с диском напрямую.
        const data = await fetchJson(API_BASE + "/read?path=" + encodeURIComponent(fullPath));
        modelMtimesRef.current.set(fullPath, mtime);
        bomRef.current.set(fullPath, !!data.bom);
        encRef.current.set(fullPath, data.encoding || "utf-8");
        if (data.content === model.getValue()) return;
        const isDirty = openBuffersRef.current.has(fullPath);
        if (isDirty) {
          // Ссылку на перезагрузку ставим ДО плашки: пока она стоит, сообщение
          // не гаснет само — оно ждёт решения человека.
          externalReloadRef.current = async () => {
            try {
              const data = await fetchJson(API_BASE + "/read?path=" + encodeURIComponent(fullPath));
              const ed = editorRef.current;
              const st = ed?.saveViewState?.();
              programmaticSetRef.current += 1;
              try { model.setValue(data.content); } finally { programmaticSetRef.current -= 1; }
              if (ed && st) {
                requestAnimationFrame(() => {
                  const e2 = editorRef.current;
                  if (e2 && !e2.isDisposed?.() && modelRef.current === model) { try { e2.restoreViewState(st); } catch {} }
                });
              }
              setOpenContent(data.content);
              markTabDirty(fullPath, false);
              setDirty(false);
              showNotice(null);
              refreshGitDecorationsRef.current?.(fullPath);
            } catch {}
          };
          showNotice("Файл изменён на диске. Ваши правки сохранены в буфере.", true, "warning");
        } else {
          const data = await fetchJson(API_BASE + "/read?path=" + encodeURIComponent(fullPath));
          // Контент совпал (mtime обновился без изменения текста) —
          // перечитывать не нужно: setValue сбросил бы историю undo.
          if (data.content === model.getValue()) return;
          const ed = editorRef.current;
          const st = ed?.saveViewState?.();
          programmaticSetRef.current += 1;
          try { model.setValue(data.content); } finally { programmaticSetRef.current -= 1; }
          if (ed && st) {
            requestAnimationFrame(() => {
              const e2 = editorRef.current;
              if (e2 && !e2.isDisposed?.() && modelRef.current === model) { try { e2.restoreViewState(st); } catch {} }
            });
          }
          setOpenContent(data.content);
          refreshGitDecorationsRef.current?.(fullPath);
        }
      }, [markTabDirty]);
      const externalReloadRef = useRef(null);
      // Программная подмена текста (hot-reload/revert): onDidChangeContent
      // не должен считать её правкой пользователя.
      const programmaticSetRef = useRef(0);

      const openSequence = useRef(0);
      const openFile = useCallback(async (rawPath) => {
        // Canonical form up front: every consumer (tabs, refs, dirty map)
        // works with one spelling of the path.
        const sequence = ++openSequence.current;
        const fullPath = normPath(rawPath);
        // Drive ALL consumers (tab highlight, refs, view-state keys) from this
        // one value — it must update on every switch, not only on first open.
        setOpenPath(fullPath);
        showNotice(null);
        try {
          addTab(fullPath);
          const monaco = monacoRef.current;
          const ed = editorRef.current;
          if (!monaco || !ed) return;
          // Remember where the outgoing tab was scrolled / positioned.
          if (openPathRef.current && modelRef.current) {
            viewStatesRef.current.set(openPathRef.current, ed.saveViewState());
          }
          const uri = monaco.Uri.from({ scheme: "bsl-workspace", authority: modelAuthority, path: "/" + fullPath });
          let model = models.get(fullPath);
          if (!model) {
            // First open in this page: parked unsaved text wins over disk
            // (covers tabs other than the active one after a session switch).
            const parked = openBuffersRef.current.get(fullPath);
            const lang = langFor(fullPath);
            if (parked != null) {
              model = monaco.editor.createModel(parked, lang, uri);
              models.set(fullPath, model);
              setOpenContent(parked);
              // Базовый mtime для parked-моделей: без него checkExternalChange
              // всегда выходит по known == null.
              fetchJson(API_BASE + "/stat?path=" + encodeURIComponent(fullPath))
                .then((d) => { modelMtimesRef.current.set(fullPath, d.mtimeMs ?? null); })
                .catch(() => {});
              // BOM для parked-моделей тоже нужен (иначе при сохранении
              // потеряется BOM файла).
              fetchJson(API_BASE + "/read?path=" + encodeURIComponent(fullPath))
                .then((d) => { bomRef.current.set(fullPath, !!d.bom); encRef.current.set(fullPath, d.encoding || "utf-8"); })
                .catch(() => {});
            } else {
              // Первый заход в этой сессии: после отрисовки диффов автопереход
              // к первому блоку изменений.
              freshOpenPathRef.current = fullPath;
              const data = await fetchJson(API_BASE + "/read?path=" + encodeURIComponent(fullPath));
              if (editorRef.current !== ed || sequence !== openSequence.current) return;
              model = models.get(fullPath) ?? monaco.editor.createModel(data.content, lang, uri);
              models.set(fullPath, model);
              setOpenContent(data.content);
              modelMtimesRef.current.set(fullPath, data.mtimeMs ?? null);
              bomRef.current.set(fullPath, !!data.bom);
              encRef.current.set(fullPath, data.encoding || "utf-8");
            }
          } else {
            setOpenContent(model.getValue());
            checkExternalChange(fullPath, model);
          }
          modelRef.current = model;
          ed.setModel(model);
          const st = viewStatesRef.current.get(fullPath);
          if (st && !suppressViewRestoreRef.current) {
            // Apply after Monaco recomputes layout for the new model —
            // a synchronous restore gets overwritten and scroll resets.
            requestAnimationFrame(() => {
              const e2 = editorRef.current;
              if (e2 && !e2.isDisposed?.() && modelRef.current === model) {
                try { Promise.resolve(e2.restoreViewState(st)).catch(() => {}); } catch {}
              }
            });
          }
          // Track edits: park the text on EVERY change (tree clicks call
          // openFile directly, bypassing switchTab, so the buffer must always
          // be current for the tab system to be lossless).
          dirtySubRef.current?.dispose?.();
          dirtySubRef.current = model.onDidChangeContent(() => {
            if (programmaticSetRef.current > 0) return;
            setDirty(true);
            markTabDirty(fullPath, true, model.getValue());
            // Keep the persist mirror current so session switches replay
            // the latest text, not the on-disk snapshot.
            setOpenContent(model.getValue());
          });
          setDirty(openBuffersRef.current.has(fullPath));
          setSaveError("");
          refreshGitDecorations(fullPath);
          return true;
        } catch (e) {
          if (sequence === openSequence.current) showNotice(String(e?.message || e), false, "warning");
        }
      }, [checkExternalChange]);

      // Возврат к окну DSH: проверить активный файл на внешние изменения,
      // даже если вкладка не переключалась.
      useEffect(() => {
        const onVisible = () => {
          if (document.visibilityState !== "visible") return;
          const p = openPathRef.current;
          const model = modelRef.current;
          if (p && model) checkExternalChange(p, model);
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);
        return () => {
          document.removeEventListener("visibilitychange", onVisible);
          window.removeEventListener("focus", onVisible);
        };
      }, [checkExternalChange]);

      // Вкладка, за которой дерево должно «догнать» редактор. Ставится при
      // переключении вкладок и после закрытия активной; разбирает его эффект
      // ниже, где уже объявлены reveal и центровка.
      const followTabRef = useRef(null);

      const switchTab = useCallback(async (path) => {
        const p = normPath(path);
        if (p === openPathRef.current) return;
        followTabRef.current = p;
        await openFile(p);
        setHighlightPath(p);
      }, [openFile]);
      const closeTab = useCallback(async (path) => {
        const rest = tabs.filter((p) => p !== path);
        setTabs(rest);
        openBuffersRef.current.delete(path);
        setTabDirty((prev) => { const s = new Set(prev); s.delete(path); return s; });
        viewStatesRef.current.delete(path);
        // Free the closed file's Monaco model (its buffer is no longer needed).
        models.get(path)?.dispose();
        models.delete(path);
        if (path === openPathRef.current) {
          const next = rest[rest.length - 1] || null;
          if (next) {
            followTabRef.current = next;
            await openFile(next);
          } else {
            setOpenPath(null);
            openPathRef.current = null;
            if (editorRef.current) editorRef.current.setModel(null);
            modelRef.current = null;
            resetDiffViewRef.current?.();
            showNotice("Выберите файл из дерева", false, "warning");
            setHighlightPath(null);
          }
        }
      }, [tabs, openFile]);

      // Снять вид диффа с текущей модели: зоны удалённых строк, подсветка
      // добавленных, кнопки изменений и состояние в шапке. Всё, что мы вешаем на
      // РЕДАКТОР (а не на модель), живёт до этой чистки — при смене файла его
      // надо звать, иначе чужие зоны остаются на новом файле.
      const clearDiffView = useCallback(() => {
        const ed = editorRef.current;
        diffNavRef.current.anchors = [];
        diffNavRef.current.index = -1;
        if (diffWidgetRef.current) diffWidgetRef.current.dom.style.display = "none";
        if (!ed) return;
        try {
          ed.changeViewZones((acc) => { for (const id of diffZoneIdsRef.current) acc.removeZone(id); });
        } catch {}
        diffZoneIdsRef.current = [];
        try {
          ed.deltaDecorations(addedDecoIdsRef.current, []);
        } catch {}
        addedDecoIdsRef.current = [];
        for (const w of hunkWidgetsRef.current) {
          try { ed.removeOverlayWidget(w); } catch {}
        }
        hunkWidgetsRef.current = [];
      }, []);

      // Снять вид диффа целиком, включая состояние в шапке (закрыли последний
      // файл — кнопок и счётчиков быть не должно).
      const resetDiffView = useCallback(() => {
        clearDiffView();
        diffHunksRef.current = [];
        reviewedRef.current = { headSha: "", hashes: new Set(), show: reviewedRef.current.show };
        setDiffState({ total: 0, unresolved: 0, reviewed: 0, show: reviewedRef.current.show });
      }, [clearDiffView]);
      resetDiffViewRef.current = resetDiffView;

      // Отрисовка вида диффа по готовым изменениям: подсветка добавленных строк,
      // «призраки» удалённых, кнопки «Отклонить/Принять» у каждого изменения,
      // навигатор и счётчики. Принятые изменения по умолчанию не рисуются вовсе —
      // в файле остаётся только то, что ещё не посмотрели.
      const renderDiffView = useCallback((path, hunks, lineCount, isNewUntracked) => {
        const ed = editorRef.current;
        const monaco = monacoRef.current;
        const model = ed && ed.getModel();
        if (!ed || !monaco || !model) return;
        const rev = reviewedRef.current;
        const isReviewed = (h) => rev.hashes.has(h.id);
        // Изменение, который лежит в индексе И уже посмотрен, из вида файла уходит:
        // с ним всё решено — он в индексе и ждёт коммита. Без этого нажатие
        // «В индекс» не меняло на экране ничего (тот же счётчик «Просмотрено»,
        // те же изменения) и читалось как «кнопка не работает». Непросмотренные
        // изменения из индекса остаются: их ещё можно принять или отклонить.
        const live = hunks.filter((h) => h.source !== "index" || !isReviewed(h));
        const shown = live.filter((h) => rev.show || !isReviewed(h));

        // 1. Подсветка добавленных строк (и «файл целиком», если он ещё не в git).
        const addedDecorations = [];
        if (isNewUntracked) {
          for (let ln = 1; ln <= lineCount; ln++) {
            addedDecorations.push({
              range: new monaco.Range(ln, 1, ln, 1),
              options: { isWholeLine: true, className: "bsl-git-added-line", linesDecorationsClassName: "bsl-git-added" },
            });
          }
        } else {
          for (const h of shown) {
            const reviewed = isReviewed(h);
            for (const ln of h.addedLines) {
              addedDecorations.push({
                range: new monaco.Range(ln, 1, ln, 1),
                options: {
                  isWholeLine: true,
                  className: reviewed ? "bsl-git-reviewed-line" : "bsl-git-added-line",
                  linesDecorationsClassName: reviewed ? "bsl-git-reviewed" : "bsl-git-added",
                },
              });
            }
          }
        }
        addedDecoIdsRef.current = ed.deltaDecorations(addedDecoIdsRef.current, addedDecorations);

        // 2. Зоны удалённых строк. В Monaco 0.52 у accessor нет removeAll —
        // треким id зон сами.
        const zoneIds = [];
        ed.changeViewZones(function (acc) {
          for (const id of diffZoneIdsRef.current) acc.removeZone(id);
          for (const h of shown) {
            const reviewed = isReviewed(h);
            for (const run of h.delRuns) {
              if (!run.lines.length) continue;
              const node = document.createElement("div");
              node.className = reviewed ? "bsl-git-del-zone bsl-git-reviewed-zone" : "bsl-git-del-zone";
              // Табы в тексте удалённых строк должны рендериться той же
              // ширины, что и в редакторе (браузерный дефолт — 8).
              const ts = model.getOptions?.().tabSize;
              if (ts) { node.style.tabSize = String(ts); node.style.MozTabSize = String(ts); }
              for (const text of run.lines) {
                const ln = document.createElement("div");
                ln.className = "bsl-git-del-line";
                ln.textContent = text;
                node.appendChild(ln);
              }
              zoneIds.push(acc.addZone({
                // afterLine — строка, ПЕРЕД которой стоит блок ⇒ зона после предыдущей
                afterLineNumber: Math.max(0, Math.min(run.afterLine - 1, lineCount)),
                heightInLines: run.lines.length,
                domNode: node,
              }));
            }
          }
        });
        diffZoneIdsRef.current = zoneIds;

        // 3. Навигация: один якорь на изменение — изменение и есть один визуальный блок.
        const anchors = shown
          .map((h) => ({ line: Math.max(1, Math.min(h.anchorLine, Math.max(lineCount, 1))), kind: h.addedLines.length ? "added" : "deleted" }))
          .sort((a, b) => a.line - b.line);
        diffNavRef.current.anchors = anchors;
        diffNavRef.current.index = -1;

        // 4. Плавающий навигатор ↑ N/M ↓ (правый верхний угол редактора).
        let w = diffWidgetRef.current;
        if (!w) {
          const dom = document.createElement("div");
          dom.style.cssText = "position:absolute;right:20px;top:10px;z-index:30;display:none;align-items:center;gap:2px;padding:3px 5px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1b1d22);border:1px solid var(--dsw-alias-border-l2,#3a3d45);box-shadow:0 4px 14px rgba(0,0,0,.35)";
          const btnCss = "border:none;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:6px;width:30px;height:30px;font-size:16px;display:inline-flex;align-items:center;justify-content:center;";
          const up = document.createElement("button");
          up.style.cssText = btnCss;
          up.textContent = "↑";
          up.title = "Предыдущее изменение (Alt+↑)";
          up.onclick = () => navigateDiffRef.current?.(-1);
          const label = document.createElement("span");
          label.style.cssText = "min-width:56px;text-align:center;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;opacity:.95;pointer-events:none;user-select:none";
          const down = document.createElement("button");
          down.style.cssText = btnCss;
          down.textContent = "↓";
          down.title = "Следующее изменение (Alt+↓)";
          down.onclick = () => navigateDiffRef.current?.(1);
          dom.appendChild(up);
          dom.appendChild(label);
          dom.appendChild(down);
          ed.addOverlayWidget({ getId: () => "bsl.gitnav", getDomNode: () => dom, getPosition: () => null });
          w = { dom, label };
          diffWidgetRef.current = w;
        }
        w.dom.style.display = (anchors.length || isNewUntracked) ? "inline-flex" : "none";
        w.label.textContent = isNewUntracked ? "новый файл" : (anchors.length ? "1 / " + anchors.length : "");

        // Миникарта занимает правый край, кнопки должны встать левее неё.
        // Размер миникарты задаёт Monaco, поэтому ширину кладём в CSS-переменную.
        const hostNode = ed.getDomNode();
        if (hostNode) {
          const mini = hostNode.querySelector(".minimap");
          hostNode.style.setProperty("--bsl-hunk-right", ((mini ? mini.offsetWidth : 0) + 26) + "px");
        }

        // 5. Кнопки у каждого изменения: «Отклонить» / «Принять» (у просмотренного —
        // «Вернуть»). Ставим их overlay-виджетами, а не content-виджетами: у
        // content-виджетов система координат — бесконечное полотно строк
        // (ширина 2^24), поэтому к правому краю редактора их не прижать:
        // «right» отсчитывался от этого полотна, и кнопки уезжали далеко за
        // экран. Слой overlay-виджетов шириной с редактор, зато строку они не
        // знают — вертикаль ставит placeHunkWidgets по строке-якорю.
        for (const widget of hunkWidgetsRef.current) {
          try { ed.removeOverlayWidget(widget); } catch {}
        }
        hunkWidgetsRef.current = [];
        const mkBtn = (text, title, cls, onClick) => {
          const b = document.createElement("button");
          b.className = "bsl-hunk-btn " + cls;
          b.type = "button";
          b.textContent = text;
          b.title = title;
          b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
          b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
          // Если кнопки уже заняты запросом (перерисовка в момент отправки),
          // новая кнопка рождается выключенной: иначе нажатие пройдёт поверх.
          b.disabled = hunkBusyRef.current;
          return b;
        };
        for (const h of shown) {
          const dom = document.createElement("div");
          dom.className = "bsl-hunk-actions";
          dom.style.display = "none";
          if (isReviewed(h)) {
            dom.appendChild(mkBtn("Вернуть", "Считать изменение непросмотренным — оно вернётся в подсветку", "", () => acceptHunkRef.current?.(h, false)));
          } else {
            dom.appendChild(mkBtn("Отклонить", "Отклонить это изменение — строки вернутся к состоянию HEAD", "bsl-hunk-btn--reject", () => rejectHunkRef.current?.(h)));
            dom.appendChild(mkBtn("Принять", "Отметить изменение просмотренным — оно уйдёт из подсветки", "bsl-hunk-btn--accept", () => acceptHunkRef.current?.(h, true)));
          }
          const line = Math.max(1, Math.min(h.anchorLine, model.getLineCount()));
          // Низ блока: последняя добавленная строка, а если изменение — только
          // удаление, то строка-якорь (под ней и стоит красный блок).
          const endLine = h.addedLines.length ? Math.min(Math.max(...h.addedLines), model.getLineCount()) : line;
          const widget = {
            getId: () => "bsl.hunk." + h.source + "." + h.index + "." + h.id,
            getDomNode: () => dom,
            getPosition: () => null,
            line,
            endLine,
            h: 0,
          };
          try {
            ed.addOverlayWidget(widget);
            hunkWidgetsRef.current.push(widget);
          } catch {}
        }
        placeHunkWidgetsRef.current?.();

        // 6. Состояние для шапки (кнопки по файлу целиком). Считаем по `live`:
        // ушедшее в индекс уже не «ждущая просмотра» работа, и счётчик
        // «Просмотрено» обязан это показать — иначе нажатие «В индекс»
        // выглядит как будто ничего не произошло.
        const next = {
          total: live.length,
          unresolved: live.filter((h) => !isReviewed(h)).length,
          reviewed: live.filter(isReviewed).length,
          show: !!rev.show,
        };
        setDiffState((prev) => (prev.total === next.total && prev.unresolved === next.unresolved && prev.reviewed === next.reviewed && prev.show === next.show ? prev : next));
      }, []);

      // Кнопки изменения: overlay-виджет строки не знает, поэтому ставим их сами —
      // под блоком изменений (так просили), а если блок кончается у нижней
      // кромки и кнопки не помещаются, то над блоком. Что ушло за пределы
      // видимой области — прячем.
      const placeHunkWidgets = useCallback(() => {
        const ed = editorRef.current;
        const model = ed && ed.getModel();
        if (!ed || !model) return;
        const hostEl = ed.getDomNode && ed.getDomNode();
        const scrollTop = ed.getScrollTop() || 0;
        // Высоту видимой области берём у самого редактора: getLayoutInfo()
        // отдаёт размер, посчитанный при последней раскладке, и у редактора,
        // созданного в скрытой вкладке, он долго остаётся нулевым — из-за этого
        // кнопки уезжали под верхнюю кромку.
        const viewH = (hostEl && hostEl.clientHeight) || (ed.getLayoutInfo() || {}).height || 0;
        const lineH = (ed.getOption && ed.getOption(monacoRef.current?.editor?.EditorOption?.lineHeight)) || 20;
        const items = [];
        for (const w of hunkWidgetsRef.current) {
          const dom = w.getDomNode();
          if (!dom) continue;
          // Высоту кнопок меряем один раз: замер заставляет браузер
          // пересчитывать раскладку, а зовут эту функцию на каждый скролл.
          if (!w.h) {
            dom.style.display = "inline-flex";
            w.h = dom.offsetHeight || 25;
          }
          const anchor = Math.max(1, Math.min(w.line, model.getLineCount()));
          const end = Math.max(anchor, Math.min(w.endLine || anchor, model.getLineCount()));
          const endY = (ed.getTopForLineNumber(end) || 0) - scrollTop;
          items.push({ dom, h: w.h, top: endY + lineH + 2 }); // строго под блоком изменений
        }
        const laid = layoutHunkWidgets(items, viewH);
        items.forEach((it, i) => {
          it.dom.style.top = (laid[i].top | 0) + "px";
          it.dom.style.display = laid[i].show ? "inline-flex" : "none";
        });
      }, []);
      placeHunkWidgetsRef.current = placeHunkWidgets;

      // Занять кнопки изменений на время запроса (и отпустить после): иначе
      // второе нажатие в другом порядке уходит на устаревшем номере изменения.
      const setHunksBusy = useCallback((busy) => {
        hunkBusyRef.current = !!busy;
        for (const w of hunkWidgetsRef.current) {
          const dom = w.getDomNode && w.getDomNode();
          if (!dom) continue;
          for (const b of dom.querySelectorAll("button")) b.disabled = !!busy;
        }
      }, []);

      // Отметки уезжают на хост вместе с ОТПЕЧАТКОМ текста каждого изменения: по
      // нему хост и отбирает, что отправить в индекс (см. /bsl/stage).
      const postReviewed = useCallback(async (path) => {
        const rev = reviewedRef.current;
        // В хранилище уходят только отметки, которым есть чему соответствовать
        // — изменениям, которые сейчас есть в файле. Набор `rev.hashes` шире: он
        // копится за сессию, и в нём остаются id правок, которых в файле уже
        // нет (правку отклонили, или она изменилась после просмотра). Такие id
        // никто не может сопоставить, а в отчёте «В индекс» они всплывали как
        // «N изменений не совпали — файл менялся после просмотра», хотя файл
        // никто не менял.
        const liveIds = new Set(diffHunksRef.current.map((h) => h.id));
        const marks = diffHunksRef.current
          .filter((h) => rev.hashes.has(h.id))
          .map((h) => ({ id: h.id, fp: hashChunk(h.text) })); // отпечаток текста, не текст
        const hashes = [...rev.hashes].filter((id) => liveIds.has(id));
        try {
          const res = await request(API_BASE + "/reviewed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, hashes, marks }),
          });
          // Молчать об этом нельзя: если отметки не сохранились, следующий
          // ответ хоста вернёт принятые изменения в счётчик, и выглядит это как
          // «кнопка сама сбрасывает просмотр».
          if (!res.ok) console.warn("[bsl] отметки не сохранились: HTTP " + res.status);
        } catch (e) {
          console.warn("[bsl] отметки не сохранились: " + (e?.message || String(e)));
        }
      }, []);

      // Отметка «просмотрено» по изменению (+ запись отметок на диск: они живут
      // между сессиями и привязаны к текущему HEAD).
      const acceptHunk = useCallback(async (hunk, accept) => {
        const path = openPathRef.current;
        if (!path) return;
        const rev = reviewedRef.current;
        if (accept) rev.hashes.add(hunk.id);
        else rev.hashes.delete(hunk.id);
        const ed = editorRef.current;
        renderDiffView(path, diffHunksRef.current, ed?.getModel()?.getLineCount() || 0, false);
        await postReviewed(path);
      }, [renderDiffView, postReviewed]);
      acceptHunkRef.current = acceptHunk;

      // Отказ изменения: возврат к HEAD делает git (`git apply -R` по изменению) —
      // строки в файле меняет он, а не редактор, поэтому после отката файл
      // перечитывается с диска.
      const rejectHunk = useCallback(async (hunk) => {
        const path = openPathRef.current;
        if (!path) return;
        if (openBuffersRef.current.has(path)) {
          showNotice("Сначала сохраните файл (Ctrl+S): иначе откат потеряет несохранённые правки", false, "warning");
          return;
        }
        if (hunkBusyRef.current) return;
        setHunksBusy(true);
        try {
          const res = await request(API_BASE + "/revert-hunk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, index: hunk.index, source: hunk.source, expect: hunk.header }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) showNotice("Отклонить не удалось: " + (data.error || ("HTTP " + res.status)), false, "warning");
          else showNotice(null);
        } catch (e) {
          showNotice("Отклонить не удалось: " + (e?.message || String(e)), false, "warning");
        } finally {
          setHunksBusy(false);
        }
        await revertFileRef.current?.();
      }, [setHunksBusy]);
      rejectHunkRef.current = rejectHunk;

      // Файл целиком: «Принять все» — отметить просмотренными все изменения;
      // «Отклонить все» — вернуть файл к HEAD (git checkout HEAD -- файл).
      const acceptAllHunks = useCallback(async () => {
        const path = openPathRef.current;
        if (!path) return;
        const rev = reviewedRef.current;
        for (const h of diffHunksRef.current) rev.hashes.add(h.id);
        const ed = editorRef.current;
        renderDiffView(path, diffHunksRef.current, ed?.getModel()?.getLineCount() || 0, false);
        await postReviewed(path);
      }, [renderDiffView, postReviewed]);

      // Показать/спрятать просмотренные изменения: спрятанные по умолчанию, а
      // показать их нужно, чтобы вернуть ошибочно принятый изменение в работу.
      const toggleReviewedShow = useCallback(() => {
        const rev = reviewedRef.current;
        rev.show = !rev.show;
        const path = openPathRef.current;
        if (!path) return;
        const ed = editorRef.current;
        renderDiffView(path, diffHunksRef.current, ed?.getModel()?.getLineCount() || 0, false);
      }, [renderDiffView]);

      const rejectAllHunks = useCallback(async () => {
        const path = openPathRef.current;
        if (!path) return;
        if (openBuffersRef.current.has(path)) {
          showNotice("Сначала сохраните файл (Ctrl+S): иначе откат потеряет несохранённые правки", false, "warning");
          return;
        }
        if (hunkBusyRef.current) return;
        setHunksBusy(true);
        try {
          const res = await request(API_BASE + "/revert-file", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) showNotice("Отклонить не удалось: " + (data.error || ("HTTP " + res.status)), false, "warning");
          else showNotice(null);
        } catch (e) {
          showNotice("Отклонить не удалось: " + (e?.message || String(e)), false, "warning");
        } finally {
          setHunksBusy(false);
        }
        reviewedRef.current.hashes = new Set();
        await revertFileRef.current?.();
      }, [setHunksBusy]);

      // Первый клик взводит «подтверждение» на 4 секунды, второй — откатывает
      // файл: откат стирает правки в рабочей копии без возврата.
      const onRejectAllClick = useCallback(() => {
        if (rejectAllTimerRef.current) {
          clearTimeout(rejectAllTimerRef.current);
          rejectAllTimerRef.current = null;
        }
        if (!rejectAllArmedRef.current) {
          rejectAllArmedRef.current = true;
          setRejectAllArmed(true);
          rejectAllTimerRef.current = setTimeout(() => {
            rejectAllArmedRef.current = false;
            rejectAllTimerRef.current = null;
            setRejectAllArmed(false);
          }, 4000);
          return;
        }
        rejectAllArmedRef.current = false;
        setRejectAllArmed(false);
        rejectAllHunks();
      }, [rejectAllHunks]);
      useEffect(() => () => { if (rejectAllTimerRef.current) clearTimeout(rejectAllTimerRef.current); }, []);

      const refreshGitDecorations = useCallback(async (path) => {
        if (!editorRef.current || !monacoRef.current) return;
        // Вызовы из onDidChangeModelContent приходят без аргумента — берём текущий файл
        if (path == null) path = openPathRef.current;
        if (!path) return;
        try {
          // Diff и отметки «просмотрено» — параллельно: отметки нужны, чтобы
          // не рисовать уже посмотренные изменения.
          const [data, revData] = await Promise.all([
            fetchJson(API_BASE + "/git-diff?path=" + encodeURIComponent(path)),
            fetchJson(API_BASE + "/reviewed?path=" + encodeURIComponent(path)).catch(() => ({ hashes: [] })),
          ]);
          const diff = data.diff || "";
          // Гонка: пока летел запрос, пользователь мог переключить файл —
          // декорации и зоны чужого диффа применять нельзя. Проверяем модель
          // ДО любых deltaDecorations/changeViewZones.
          const ed = editorRef.current;
          const model = ed?.getModel();
          if (!model || model !== models.get(normPath(path))) return;
          const lineCount = model.getLineCount();
          const rev = reviewedRef.current;
          const prevHead = rev.headSha;
          rev.hashes = mergeReviewedHashes(rev.hashes, prevHead, revData.hashes, revData.headSha || "");
          rev.headSha = revData.headSha || "";
          // Хост отдаёт индекс и рабочую копию раздельно (откатываются они
          // по-разному). Старый хост без этих полей — diff целиком как рабочая копия.
          const cD = data.cachedDiff, wD = data.workDiff;
          diffHunksRef.current = (cD === undefined && wD === undefined)
            ? parseDiffHunks(diff, "worktree")
            : [...parseDiffHunks(cD || "", "index"), ...parseDiffHunks(wD || "", "worktree")];
          // Файл ещё не в git (новый объект): базы для diff нет, значит diff
          // пуст — без этого свежесохранённый файл выглядит «без изменений».
          // Помечаем все строки как добавленные (gutter как в VS Code).
          const relPath = (() => {
            let s = normPath(path);
            const r = normPath(rootPathRef.current || "");
            if (r && s.toLowerCase().startsWith(r.toLowerCase())) s = s.slice(r.length).replace(/^\/+/, "");
            return s;
          })();
          const isNewUntracked = !diff.trim() && String(gitFilesRef.current.get(relPath) || "").includes("?");
          renderDiffView(path, diffHunksRef.current, lineCount, isNewUntracked);
          // Свежеоткрытый файл с диффами: сразу позиционируем на первый блок.
          // Признак свежести сбрасываем по факту ЛЮБОГО завершённого refresh
          // этого файла: если диффов не было, флаг не должен дожить до первой
          // правки (появится дифф — случится ложный автопереход).
          const isFreshOpen = freshOpenPathRef.current === normPath(path);
          freshOpenPathRef.current = null;
          if (isFreshOpen && diffNavRef.current.anchors.length) {
            const ed2 = editorRef.current;
            if (ed2 && !ed2.isDisposed?.()) {
              requestAnimationFrame(() => {
                gotoAnchorRef.current?.(0);
              });
            }
          }
        } catch {}
      }, [clearDiffView, renderDiffView]);
      refreshGitDecorationsRef.current = refreshGitDecorations;

      // Проиндексировать просмотренное. В индекс уходят только помеченные
      // изменения — остальные строки файла остаются как были; после этого они
      // пропадают из подсветки и счётчика (у одного и того же изменения в индексе
      // и в рабочей копии одинаковый признак содержимого). Несохранённый
      // буфер не индексируем: в индекс ушла бы версия с диска, а не с экрана.
      const stageFile = useCallback(async () => {
        const path = openPathRef.current;
        if (!path) return;
        if (openBuffersRef.current.has(path)) {
          showNotice("Сначала сохраните файл (Ctrl+S): иначе в индекс уйдёт версия с диска, а не то, что в редакторе", false, "warning");
          return;
        }
        if (hunkBusyRef.current) return;
        setHunksBusy(true);
        try {
          const res = await request(API_BASE + "/stage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            showNotice("В индекс не удалось: " + (data.error || ("HTTP " + res.status)), false, "warning");
            console.warn("[bsl] в индекс — ошибка", { path, status: res.status, data });
            return;
          }
          // Тишина в ответ на нажатие читается как поломка кнопки: называем
          // причину словами и всегда оставляем след в консоли.
          console.info("[bsl] в индекс", { path, ...data });
          showNotice(stageReasonText(data), false, stageTone(data));
          if (!data.staged && !data.untracked) return; // менять нечего
          await refreshGitDecorationsRef.current?.(path);
          // Новый файл уходит в индекс целиком: отмечаем его просмотренным,
          // иначе он тут же вернётся в счётчик одним большим изменением.
          if (data.untracked) await acceptAllHunks();
          refreshGit();
        } catch (e) {
          showNotice("В индекс не удалось: " + (e?.message || String(e)), false, "warning");
        } finally {
          setHunksBusy(false);
        }
      }, [acceptAllHunks, refreshGit, setHunksBusy]);

      // То же по всем изменённым файлам проекта разом.
      const stageAllReviewed = useCallback(async () => {
        if (hunkBusyRef.current) return;
        setStageAllBusy(true);
        setHunksBusy(true);
        try {
          const res = await request(API_BASE + "/stage-all", { method: "POST" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            showNotice("В индекс не удалось: " + (data.error || ("HTTP " + res.status)), false, "warning");
            return;
          }
          console.info("[bsl] в индекс (все изменённые файлы)", { ...data });
          showNotice(stageAllReasonText(data), false, stageTone(data));
          const p = openPathRef.current;
          if (p) await refreshGitDecorationsRef.current?.(p);
          refreshGit();
        } catch (e) {
          showNotice("В индекс не удалось: " + (e?.message || String(e)), false, "warning");
        } finally {
          setStageAllBusy(false);
          setHunksBusy(false);
        }
      }, [refreshGit, setHunksBusy]);

      // Коммит: сообщение пишет человек, а окно показывает, что лежит в индексе.
      const openCommitBox = useCallback(async () => {
        setCommitOpen(true);
        setCommitError("");
        try {
          const data = await fetchJson(API_BASE + "/staged");
          setCommitFiles(Array.isArray(data?.files) ? data.files : []);
        } catch {
          setCommitFiles([]);
        }
      }, []);
      const closeCommitBox = useCallback(() => {
        setCommitOpen(false);
        setCommitError("");
        setCommitMsg("");
      }, []);
      const doCommit = useCallback(async () => {
        const message = commitMsg.trim();
        if (!message) {
          setCommitError("Напишите сообщение коммита");
          return;
        }
        setCommitBusy(true);
        setCommitError("");
        try {
          const res = await request(API_BASE + "/commit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            setCommitError(data.error || ("HTTP " + res.status));
            return;
          }
          setCommitOpen(false);
          setCommitMsg("");
          setCommitFiles([]);
          showNotice("Закоммичено: " + (data.summary || (data.files + " файлов")), false, "success");
          const p = openPathRef.current;
          if (p) await refreshGitDecorationsRef.current?.(p);
          refreshGit();
        } catch (e) {
          setCommitError(e?.message || String(e));
        } finally {
          setCommitBusy(false);
        }
      }, [commitMsg, refreshGit]);

      // Persist the open model back to disk via the host /bsl/write route.
      const saveFile = useCallback(async () => {
        const model = modelRef.current;
        const path = openPathRef.current;
        if (!model || !path) return;
        if (saving) return;
        setSaving(true);
        setSaveError("");
        try {
          const res = await request(API_BASE + "/write", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              path,
              content: model.getValue(),
              bom: bomRef.current.get(path) ?? false,
              encoding: encRef.current.get(path) || "utf-8",
            }),
          });
          if (!res.ok) throw await errorFromResponse(res);
          setDirty(false);
          markTabDirty(path, false);
          // Обновить известный mtime: наша же запись на диске не должна
          // выглядеть как внешнее изменение при следующем checkExternalChange.
          try {
            const st = await fetchJson(API_BASE + "/stat?path=" + encodeURIComponent(path));
            modelMtimesRef.current.set(path, st.mtimeMs ?? null);
          } catch {}
          refreshGitDecorations(path);
          // Бейджи в дереве и список «Изменённые» берут данные из
          // /bsl/git-status — без обновления сохранённый файл не появится там
          // до следующего триггера (хост сбрасывает свой кэш на записи).
          refreshGit();
        } catch (e) {
          setSaveError(e?.message || String(e));
        } finally {
          setSaving(false);
        }
      }, [saving, refreshGitDecorations, refreshGit]);
      const saveFileRef = useRef(null);
      saveFileRef.current = saveFile;

      // Revert the active file: re-read from disk, drop unsaved edits and the
      // parked buffer, refresh git decorations. Keeps scroll position.
      const revertFile = useCallback(async () => {
        const path = openPathRef.current;
        const model = modelRef.current;
        if (!path || !model) return;
        try {
          const data = await fetchJson(API_BASE + "/read?path=" + encodeURIComponent(path));
          if (model.getValue() !== data.content) {
            // Preserve the view across the buffer swap.
            const ed = editorRef.current;
            const st = ed?.saveViewState?.();
            model.setValue(data.content);
            if (ed && st) {
              requestAnimationFrame(() => {
                const e2 = editorRef.current;
                if (e2 && !e2.isDisposed?.() && modelRef.current === model) { try { e2.restoreViewState(st); } catch {} }
              });
            }
          }
          setOpenContent(data.content);
          // mtime на диске мог измениться с момента загрузки (внешняя правка,
          // которую revert только что подтянул) — фиксируем актуальное значение.
          try {
            const st = await fetchJson(API_BASE + "/stat?path=" + encodeURIComponent(path));
            modelMtimesRef.current.set(path, st.mtimeMs ?? null);
          } catch {}
          markTabDirty(path, false);
          setDirty(false);
          setSaveError("");
          refreshGitDecorations(path);
          refreshGit();
        } catch (e) {
          setSaveError(e?.message || String(e));
        }
      }, [markTabDirty, refreshGitDecorations, refreshGit]);
      const revertFileRef = useRef(null);
      revertFileRef.current = revertFile;

      // Cursor-style inline diff navigation: cycle through change anchors
      // (added lines + deleted-block zones), reveal and flash each one.
      // Переход к якорю i + подсветка + актуализация счётчика.
      // Программный скролл от revealLineInCenter триггерит onDidScrollChange;
      // флаг не даёт syncDiffNav пересчитать index во время перехода.
      let navJumping = false;
      const gotoAnchor = useCallback((i) => {
        const ed = editorRef.current;
        const monaco = monacoRef.current;
        const nav = diffNavRef.current;
        if (!ed || !monaco || !nav || !nav.anchors.length) return;
        nav.index = i;
        navJumping = true;
        try {
          ed.revealLineInCenter(nav.anchors[i].line);
          ed.setPosition({ lineNumber: nav.anchors[i].line, column: 1 });
          const flashIds = ed.deltaDecorations([], [{
            range: new monaco.Range(nav.anchors[i].line, 1, nav.anchors[i].line, 1),
            options: { isWholeLine: true, className: "bsl-git-flash" },
          }]);
          setTimeout(() => {
            try { ed.deltaDecorations(flashIds, []); } catch {}
          }, 650);
        } finally {
          setTimeout(() => { navJumping = false; }, 120);
        }
        if (diffWidgetRef.current) diffWidgetRef.current.label.textContent = (i + 1) + " / " + nav.anchors.length;
      }, []);
      // Синхронизация навигатора с реальной позицией в файле: текущим считается
      // якорь, ближайший к центру видимой области.
      const syncDiffNav = useCallback(() => {
        if (navJumping) return;
        const ed = editorRef.current;
        const nav = diffNavRef.current;
        if (!ed || !nav || !nav.anchors.length || !diffWidgetRef.current) return;
        const visible = ed.getVisibleRanges();
        if (!visible.length) return;
        const top = visible[0].startLineNumber;
        const bottom = visible[visible.length - 1].endLineNumber;
        const mid = Math.floor((top + bottom) / 2);
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < nav.anchors.length; i++) {
          const d = Math.abs(nav.anchors[i].line - mid);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        if (best !== nav.index) {
          nav.index = best;
          diffWidgetRef.current.label.textContent = (best + 1) + " / " + nav.anchors.length;
        }
      }, []);

      gotoAnchorRef.current = gotoAnchor;
      syncDiffNavRef.current = syncDiffNav;

      // Шаг считаем от КУРСОРА, а не от сохранённого индекса: после «Принять»
      // изменение исчезает, индекс сбрасывается, и шаг от «ближайшего к центру
      // экрана» перескакивал ближайшее изменение — счётчик при этом врал.
      const navigateDiff = useCallback((dir) => {
        const ed = editorRef.current;
        const nav = diffNavRef.current;
        if (!ed || !nav || !nav.anchors.length) return;
        const anchors = nav.anchors;
        const pos = ed.getPosition?.();
        const cursor = pos && pos.lineNumber ? pos.lineNumber : 1;
        let i;
        if (dir > 0) {
          i = anchors.findIndex((x) => x.line > cursor);
          if (i < 0) i = 0; // ниже изменений нет — идём на первое
        } else {
          i = -1;
          for (let k = 0; k < anchors.length; k++) if (anchors[k].line < cursor) i = k;
          if (i < 0) i = anchors.length - 1; // выше изменений нет — идём на последнее
        }
        gotoAnchor(i);
      }, [gotoAnchor]);
      navigateDiffRef.current = navigateDiff;


      // Переход к определению (F12) по модели метаданных. Точное разрешение
      // для «[Коллектор.]Модуль.Метод»,
      // otherwise a name-wide search; repeated F12 cycles through candidates.
      useEffect(() => {
        if (!monacoReady || !monacoRef.current || !editorRef.current) return;
        const monaco = monacoRef.current;
        const editor = editorRef.current;
        const staticDef = async (model, position) => {
          try {
            // F12 осмыслен только для BSL: в XML/.md определений нет, и раньше
            // это выглядело как «клавиша не работает» без единого сообщения.
            if (model.getLanguageId?.() !== "bsl") {
              console.info("[dsh-bsl-editor] F12: файл не на BSL (" + (model.getLanguageId?.() || "?") + ") — переход к определению недоступен");
              return null;
            }
            const word = wordAt(model, position);
            if (!word) return null;
            const prev = staticNavRef.current;
            if (prev && prev.word === word && prev.targets.length) {
              const idx = (prev.index + 1) % prev.targets.length;
              prev.index = idx;
              const t = prev.targets[idx];
              suppressViewRestoreRef.current = true;
              try { await openFile(t.file); } finally { suppressViewRestoreRef.current = false; }
              const ed = editorRef.current;
              if (ed) { ed.setPosition({ lineNumber: t.line, column: t.col }); ed.revealPositionInCenter({ lineNumber: t.line, column: t.col }); }
              return null;
            }
            const curFile = model.uri.path.slice(1);
            const res = await fetchJson(
              API_BASE + "/find-symbol?name=" + encodeURIComponent(word) +
              "&file=" + encodeURIComponent(curFile)
            );
            const targets = res.targets || [];
            if (!targets.length) {
              staticNavRef.current = null;
              console.info("[dsh-bsl-editor] F12: определение не найдено — «" + word + "» (" + curFile + ")");
              return null;
            }
            staticNavRef.current = { word, targets, index: 0 };
            const t = targets[0];
            suppressViewRestoreRef.current = true;
            try { await openFile(t.file); } finally { suppressViewRestoreRef.current = false; }
            const ed = editorRef.current;
            if (ed) { ed.setPosition({ lineNumber: t.line, column: t.col }); ed.revealPositionInCenter({ lineNumber: t.line, column: t.col }); }
            return null;
          } catch (e) {
            console.error("[dsh-bsl-editor] static definition", e);
            return null;
          }
        };
        // Definition provider НЕ регистрируем (включает нативный Ctrl+клик) —
        // переход к определению только по F12.
        const disp = null;
        // Intercept F12 so Monaco doesn't show its own "No definition found"
        // toast on a miss — we do the navigation (and the toast) ourselves.
        if (!f12BoundRef.current) {
          f12BoundRef.current = editor.addCommand(monaco.KeyCode.F12, () => {
            const ed = editorRef.current;
            if (!ed) return;
            const m = ed.getModel();
            const pos = ed.getPosition();
            if (!m || !pos) return;
            staticDef(m, pos);
          });
        }
        return () => disp?.dispose?.();
      }, [monacoReady, openFile]);

      // Restore the tree scroll position once the tree has rendered (children
      // come back from editorPersist synchronously, so the first paint already
      // has the content).
      const treeScrollRestoredRef = useRef(false);
      useEffect(() => {
        if (treeScrollRestoredRef.current) return;
        const body = treeBodyRef.current;
        if (!body || body.scrollHeight <= body.clientHeight) {
          treeScrollRestoredRef.current = true;
          return;
        }
        if (editorPersist.treeScrollTop > 0) body.scrollTop = editorPersist.treeScrollTop;
        treeScrollRestoredRef.current = true;
      }, [children, metaChildren]);

      // Load the workspace root on first mount only. On a remount the tree
      // comes back from editorPersist already populated — refetching the root
      // would flash "Загрузка…" and collapse nothing, but is still useful to
      // refresh git badges.
      const treeRestoredRef = useRef(false);
      useEffect(() => {
        // Config arrives async and may have just changed (Settings → save):
        // refetch git statuses so untracked visibility follows immediately.
        refreshGit();
        if (!treeRestoredRef.current && children.size === 0) {
          treeRestoredRef.current = true;
          loadDir(rootPath || "");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [loadDir, refreshGit]);
      useEffect(() => {
        if (cfg) refreshGit();
      }, [cfg]); // eslint-disable-line react-hooks/exhaustive-deps

      // Restore the previously open file + caret after Monaco is ready.
      const restoreDoneRef = useRef(false);
      useEffect(() => {
        if (!monacoReady || restoreDoneRef.current || target) return;
        const p = editorPersist.openPath;
        if (!p) { restoreDoneRef.current = true; return; }
        restoreDoneRef.current = true;
        openFile(p).then(() => {
          const ed = editorRef.current;
          if (!ed) return;
          // Unsaved edits already live in the Monaco model (openFile seeds it
          // from the parked buffer), so only the caret/scroll need replaying.
          // Monaco computes the layout asynchronously after setModel, and
          // setPosition/reveal can re-scroll after our first attempt, so
          // keep re-applying until the editor actually sits at the saved
          // scrollTop (or give up after a bounded number of tries).
          const cur = editorPersist.cursor;
          if (cur) ed.setPosition(cur);
          // Monaco computes the layout asynchronously after setModel, and
          // setPosition/reveal can re-scroll after our first attempt, so
          // keep re-applying until the editor actually sits at the saved
          // scrollTop (or give up after a bounded number of tries).
          const savedScroll = editorPersist.scrollTop;
          if (savedScroll) {
            let attempts = 0;
            const tryApply = () => {
              const e2 = editorRef.current;
              if (!e2 || (typeof e2.isDisposed === "function" && e2.isDisposed())) return;
              if (Math.abs((e2.getScrollTop() || 0) - savedScroll) < 2) return; // already there
              e2.setScrollTop(savedScroll);
              attempts += 1;
              if (attempts < 8) setTimeout(tryApply, 120 + attempts * 60);
            };
            requestAnimationFrame(tryApply);
            // Safety net: if the tab was hidden, rAF never fires — apply on
            // the next tick instead so the restore isn't lost.
            setTimeout(tryApply, 250);
          }
        });
      }, [monacoReady, openFile]);

      // Debounced search (files: /bsl/search, metadata: /bsl/meta/search).
      useEffect(() => {
        const q = search.trim();
        if (!q) { setSearchResults([]); return; }
        let alive = true;
        const t = setTimeout(async () => {
          try {
            // В режиме «Изменённые» поиск ограничен файлами из git-status.
            const url = mode === "meta"
              ? API_BASE + "/meta/search?q=" + encodeURIComponent(q)
              : API_BASE + "/search?q=" + encodeURIComponent(q) + (gitFilter ? "&changed=1" : "");
            const data = await fetchJson(url);
            if (alive) setSearchResults(data.results || []);
          } catch {
            if (alive) setSearchResults([]);
          }
        }, 120);
        return () => { alive = false; clearTimeout(t); };
      }, [search, mode, gitFilter]);

      // Reveal a path in the tree: clear the search, load + expand every
      // directory from the root down to the target (inclusive), highlight it,
      // and scroll it into view so its nested files are one click away.
      const reveal = useCallback(async (fullPath) => {
        setSearch("");
        // Сравниваем пути в одной форме: openPath приходит с прямыми слешами,
        // а строки дерева собраны joinPath с обратными — иначе префикс корня не
        // совпадает и папки раскрываются от «D:».
        const target = normPath(fullPath);
        const rootNorm = normPath(rootPath).replace(/\/+$/, "");
        let rel = target;
        if (rootNorm && target.toLowerCase().startsWith(rootNorm.toLowerCase() + "/")) {
          rel = target.slice(rootNorm.length + 1);
        } else if (rootNorm && target.toLowerCase().startsWith(rootNorm.toLowerCase())) {
          rel = target.slice(rootNorm.length).replace(/^\/+/, "");
        }
        const segs = rel.split("/").filter(Boolean);
        let current = rootPath;
        const newExpanded = new Set(expanded);
        const loaded = new Set(children.keys());
        // Последний сегмент — сам файл: его листинг не нужен (loadDir на файле
        // падает с ENOTDIR → 400).
        const dirSegs = segs.length > 1 ? segs.slice(0, -1) : segs;
        for (const seg of dirSegs) {
          const dirPath = joinPath(current, seg);
          if (!loaded.has(dirPath)) await loadDir(dirPath);
          loaded.add(dirPath);
          newExpanded.add(dirPath);
          current = dirPath;
        }
        setExpanded(newExpanded);
        // Подсветка и прокрутка ищут путь в том виде, в каком он у строк дерева.
        const treePath = segs.length ? joinPath(current, segs[segs.length - 1]) : current;
        setHighlightPath(treePath);
        return treePath;
      }, [rootPath, expanded, children, loadDir]);

      // Поставить строку дерева по центру видимой области.
      const centerRow = (el) => {
        const body = treeBodyRef.current;
        if (!body || !el) return;
        const rect = el.getBoundingClientRect();
        const box = body.getBoundingClientRect();
        const offset = body.scrollTop + (rect.top - box.top) - (box.height - rect.height) / 2;
        body.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
      };

      const centerPathInTree = (fullPath) => {
        const body = treeBodyRef.current;
        if (!body || !fullPath) return false;
        const el = [...body.querySelectorAll("[data-path]")].find((node) => node.dataset.path === fullPath);
        if (!el) return false;
        centerRow(el);
        return true;
      };

      // Escape закрывает меню, как в обычных приложениях.
      useEffect(() => {
        if (!codeMenu) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") setCodeMenu(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [codeMenu]);

      // Где открытый файл — в том дереве, которое сейчас на экране. В метаданных
      // нужный лист может быть уже отрисован: центрируем его. Если его там нет,
      // переключаемся на «Файлы»: там файл найдётся всегда.
      const showInTree = async () => {
        const target = openPathRef.current || openPath;
        if (!target) {
          showNotice("Сначала откройте файл", false, "warning");
          return;
        }
        if (mode === "meta") {
          const body = treeBodyRef.current;
          const same =
            body &&
            [...body.querySelectorAll("[data-meta-path]")].find(
              (node) => node.dataset.metaPath && normPath(node.dataset.metaPath) === normPath(target),
            );
          if (same) {
            setMetaHighlight(same.dataset.metaPath);
            centerRow(same);
            return;
          }
          setMode("files");
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        const treePath = await reveal(target);
        setTimeout(() => centerPathInTree(treePath), 120);
      };

      // Переключили вкладку — дерево показывает её файл: подсветка и центровка в
      // той области, которая сейчас на экране. Режим не переключаем, подсказок не
      // показываем: это поведение «Показать в дереве», только по факту перехода.
      useEffect(() => {
        const target = followTabRef.current;
        if (!target || target !== openPath) return undefined;
        followTabRef.current = null;
        let alive = true;
        const follow = async () => {
          if (mode === "meta") {
            const body = treeBodyRef.current;
            const same =
              body &&
              [...body.querySelectorAll("[data-meta-path]")].find(
                (node) => node.dataset.metaPath && normPath(node.dataset.metaPath) === normPath(target),
              );
            // Узла нет — раздел свёрнут или файл не из метаданных; центровать нечего.
            if (!same) return;
            setMetaHighlight(same.dataset.metaPath);
            centerRow(same);
            return;
          }
          const rootNorm = normPath(rootPath).replace(/\/+$/, "");
          const pathNorm = normPath(target);
          // Файл вне корня проекта (вкладка могла приехать из чата): раскрывать
          // от корня нечего, оставляем только подсветку вкладки.
          if (!rootNorm || !pathNorm.toLowerCase().startsWith(rootNorm.toLowerCase())) return;
          // Идёт поиск по дереву: reveal его сбросит и сотрёт запрос — не трогаем.
          if (search.trim()) return;
          const treePath = await reveal(target);
          if (!alive) return;
          setTimeout(() => {
            if (alive) centerPathInTree(treePath);
          }, 120);
        };
        follow().catch((e) => console.error("[dsh-bsl-editor] follow tab", e));
        return () => {
          alive = false;
        };
      }, [openPath, mode, search]);

      // Путь модуля относительно корня проекта — в буфер обмена.
      const copyModulePath = async () => {
        const model = modelRef.current;
        if (!model) return;
        const full = model.uri.path.slice(1).replace(/^\/+/, "");
        const root = (rootPathRef.current || "").replace(/\\/g, "/").replace(/^\/+/, "");
        const rel =
          root && full.toLowerCase().startsWith(root.toLowerCase()) ? full.slice(root.length).replace(/^\/+/, "") : full;
        try {
          await navigator.clipboard.writeText(rel);
          showNotice("Путь скопирован: " + rel, false, "success");
        } catch {
          showNotice("Буфер обмена недоступен", false, "warning");
        }
      };

      const runEditorAction = (id) => {
        const ed = editorRef.current;
        setCodeMenu(null);
        if (!ed) return;
        ed.trigger("menu", id, null);
        ed.focus();
      };

      const referenceSelection = () => {
        const ed = editorRef.current;
        const model = modelRef.current;
        const sel = ed && ed.getSelection();
        setCodeMenu(null);
        if (!sel || sel.isEmpty() || !model) return;
        const full = (openPathRef.current || "").replace(/^\/+/, "");
        let rel = full;
        const r = (rootPathRef.current || "").replace(/\\/g, "/").replace(/^\/+/, "");
        if (r && rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length).replace(/^\/+/, "");
        const a = sel.startLineNumber;
        const b = sel.endLineNumber;
        sendToChat(composer, props.threadId, rel + (a === b ? ":" + a : ":" + a + "-" + b));
      };

      const codeMenuItem = (label, hint, onSelect) =>
        jsxs("div", {
          className: "dsh-bsl-menu-item",
          onClick: onSelect,
          style: {
            display: "flex", alignItems: "center", gap: 12, padding: "6px 10px",
            borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap",
          },
          children: [
            jsx("span", { style: { flex: 1 }, children: label }),
            hint ? jsx("span", { style: { opacity: 0.45, fontSize: 11 }, children: hint }) : null,
          ],
        });

      const codeMenuSeparator = (key) =>
        jsx("div", {
          key,
          style: { height: 1, margin: "4px 6px", background: "var(--dsw-alias-hairline, rgba(127,127,127,.25))" },
        });

      // Меню по правой кнопке: свои подписи по-русски вместо встроенных английских.
      const codeMenuItems = () => {
        const ed = editorRef.current;
        const selection = ed && ed.getSelection();
        const hasSelection = Boolean(selection && !selection.isEmpty());
        return [
          codeMenuItem("Вырезать", "Ctrl+X", () => runEditorAction("editor.action.clipboardCutAction")),
          codeMenuItem("Копировать", "Ctrl+C", () => runEditorAction("editor.action.clipboardCopyAction")),
          codeMenuItem("Вставить", "Ctrl+V", () => runEditorAction("editor.action.clipboardPasteAction")),
          codeMenuSeparator("s1"),
          codeMenuItem("Скопировать путь модуля", "", () => { setCodeMenu(null); copyModulePath(); }),
          hasSelection ? codeMenuItem("Добавить к обсуждению", "", referenceSelection) : null,
          codeMenuItem("Показать в дереве", "", () => { setCodeMenu(null); showInTree(); }),
        ];
      };

      // Мост для перехватчика openPath: обновляется при изменении колбэков,
      // чистится при размонтировании. При монтировании применяется очередь
      // Переход на строку: модель уже открыта, остаётся поставить курсор и
      // прокрутить так, чтобы строка была по центру.
      const goToLine = useCallback((line, column) => {
        const ed = editorRef.current;
        const model = modelRef.current;
        if (!ed || !model || !line) return;
        const total = model.getLineCount();
        const target = Math.min(Math.max(1, Math.round(line)), Math.max(1, total));
        const col = Math.min(Math.max(1, Math.round(column || 1)), 400);
        ed.setPosition({ lineNumber: target, column: col });
        ed.revealPositionInCenter({ lineNumber: target, column: col });
        ed.focus();
      }, []);

      useEffect(() => {
        if (!monacoReady || !target || !rootPath) return;
        let active = true;
        const path = normPath(target.path);
        const fullPath = /^(?:[a-z]:\/|\/)/i.test(path) ? path : normPath(rootPath + "/" + path);
        void openFile(fullPath).then((opened) => {
          if (opened && active && target.line) goToLine(target.line, target.column);
        });
        return () => { active = false; };
      }, [target, rootPath, openFile, goToLine, monacoReady]);

      // ── Metadata tree (1C): lazy load + expand/collapse ────────────────
      const gitFilterRef = useRef(gitFilter);
      gitFilterRef.current = gitFilter;
      const loadMeta = useCallback(async (key) => {
        setMetaLoading(true);
        setMetaLoadingKey(key || "");
        try {
          // Фильтр берём из ref — колбэк всегда видит актуальное состояние.
          const changed = mode === "meta" && gitFilterRef.current ? "&changed=1" : "";
          const url = API_BASE + "/meta/list?p=" + encodeURIComponent(key || "") + changed;
          const data = await fetchJson(url);
          if (!data.ok) throw new Error(data.error || "meta error");
          setMetaChildren((prev) => { const m = new Map(prev); m.set(key || "", data.items || []); return m; });
          setMetaError("");
          return data;
        } catch (e) {
          setMetaError(e?.message || String(e));
          return null;
        } finally {
          setMetaLoading(false);
          setMetaLoadingKey(null);
        }
      }, [mode]);

      const metaToggle = useCallback(async (key) => {
        if (metaExpanded.has(key)) {
          setMetaExpanded((prev) => { const s = new Set(prev); s.delete(key); return s; });
        } else {
          setMetaExpanded((prev) => new Set(prev).add(key));
          if (!metaChildren.has(key)) await loadMeta(key);
        }
      }, [metaExpanded, metaChildren, loadMeta]);

      // Ручное обновление дерева. Свежий файл был виден только в новой сессии
      // по двум причинам: листинги каталогов кэшируются в состоянии клиента и
      // повторно не запрашиваются, а хост держит в памяти разобранные
      // метаданные. Кнопка сбрасывает оба кэша и перечитывает то, что раскрыто.
      const refreshTree = useCallback(async () => {
        if (refreshBusy) return;
        setRefreshBusy(true);
        try {
          await fetchJson(API_BASE + "/refresh", { method: "POST" });
          if (mode === "meta") {
            const st = await fetchJson(API_BASE + "/meta/status");
            setMetaInfo(st);
            const changed = gitFilter ? "&changed=1" : "";
            const keys = ["", ...metaExpanded];
            const next = new Map();
            for (const k of keys) {
              const data = await fetchJson(API_BASE + "/meta/list?p=" + encodeURIComponent(k || "") + changed);
              if (data.ok) next.set(k || "", data.items || []);
            }
            setMetaChildren(next);
            setMetaError(st.ok ? "" : (st.error || "метаданные не найдены"));
          } else {
            const next = new Map();
            let first = true;
            for (const d of [rootPath || "", ...expanded]) {
              const data = await fetchJson(API_BASE + "/tree?path=" + encodeURIComponent(d || ""));
              next.set(data.path, data.entries);
              if (first) { setRootPath((prev) => prev || data.root || data.path); first = false; }
            }
            setChildren(next);
            setTreeError("");
            await refreshGit(true);
          }
          showNotice("Дерево обновлено", false, "success");
        } catch (e) {
          showNotice("Обновить дерево не удалось: " + (e?.message || String(e)), false, "warning");
        } finally {
          setRefreshBusy(false);
        }
      }, [refreshBusy, mode, gitFilter, metaExpanded, rootPath, expanded, refreshGit, showNotice]);

      // On first switch to metadata mode: fetch status and the root group list.
      useEffect(() => {
        if (mode !== "meta" || metaInfo) return;
        let alive = true;
        (async () => {
          try {
            const st = await fetchJson(API_BASE + "/meta/status");
            if (!alive) return;
            setMetaInfo(st);
            if (st.ok) {
              if (!metaChildren.has("")) await loadMeta("");
            }
          } catch (e) {
            if (alive) setMetaInfo({ ok: false, error: String(e) });
          }
        })();
        return () => { alive = false; };
      }, [mode, metaInfo, metaChildren, loadMeta]);

      // Reveal a metadata node: expand every ancestor segment, then highlight.
      // «Общие» is a virtual parent for common-type groups (Общие модули, …),
      // so its segment must be walked too — otherwise the row never renders
      // and the scroll/highlight silently misses.
      const revealMeta = useCallback(async (key) => {
        setSearch("");
        const segs = String(key || "").split("/").filter(Boolean);
        const rootItems = metaChildren.get("") || [];
        const common = rootItems.find((g) => g.key === "Общие");
        const commonDirs = new Set((common?.children || []).map((c) => c.key));
        const chain = [];
        for (const seg of segs) {
          if (chain.length === 0 && commonDirs.has(seg)) chain.push("Общие");
          chain.push(chain.length ? chain[chain.length - 1] + "/" + seg : seg);
        }
        const newExpanded = new Set(metaExpanded);
        const loaded = new Set(metaChildren.keys());
        for (const acc of chain) {
          if (!loaded.has(acc)) await loadMeta(acc);
          loaded.add(acc);
          newExpanded.add(acc);
        }
        setMetaExpanded(newExpanded);
        setMetaHighlight(key);
      }, [metaExpanded, metaChildren, loadMeta]);

      const META_FORMAT_LABEL = { edt: "EDT", xml: "XML-выгрузка", object: "пообъектная выгрузка" };

      // Scroll the highlighted row into view once it renders (after expand).
      // Only when the row is actually outside the visible area — a plain
      // click on an already-visible file must not yank the viewport.
      const highlightScrollRef = useRef(null);
      useEffect(() => {
        if (!highlightPath || highlightPath === highlightScrollRef.current) return;
        const body = treeBodyRef.current;
        if (!body) return;
        const list = body.querySelectorAll("[data-path]");
        let found = false;
        for (const el of list) {
          if (el.dataset.path === highlightPath) {
            const elRect = el.getBoundingClientRect();
            const bodyRect = body.getBoundingClientRect();
            const above = elRect.top < bodyRect.top;
            const below = elRect.bottom > bodyRect.bottom;
            if (above || below) {
              body.scrollTo({ top: body.scrollTop + (elRect.top - bodyRect.top), behavior: "smooth" });
            }
            found = true;
            break;
          }
        }
        if (found) highlightScrollRef.current = highlightPath;
      }, [highlightPath, expanded, children, search]);

      // Same for metadata-mode highlight — scroll ONLY when the highlighted
      // node changes (not on every expand/collapse, which made the view
      // "jump back" to a stale highlight), and only when the node is outside
      // the visible area (a plain click on a visible row must not yank).
      const metaScrollRef = useRef(null);
      useEffect(() => {
        if (!metaHighlight || metaHighlight === metaScrollRef.current) return;
        const body = treeBodyRef.current;
        if (!body) return;
        const list = body.querySelectorAll("[data-meta-path]");
        let found = false;
        for (const el of list) {
          if (el.dataset.metaPath === metaHighlight) {
            const elRect = el.getBoundingClientRect();
            const bodyRect = body.getBoundingClientRect();
            const above = elRect.top < bodyRect.top;
            const below = elRect.bottom > bodyRect.bottom;
            if (above || below) {
              body.scrollTo({ top: body.scrollTop + (elRect.top - bodyRect.top), behavior: "smooth" });
            }
            found = true;
            break;
          }
        }
        // Only mark as scrolled when the row actually rendered — otherwise
        // retry on the next state change.
        if (found) metaScrollRef.current = metaHighlight;
      }, [metaHighlight, metaExpanded, metaChildren, search]);

      // Close the context menu on Escape.
      useEffect(() => {
        if (!ctxMenu) return;
        const onKey = (e) => { if (e.key === "Escape") setCtxMenu(null); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [ctxMenu]);

      // Drag the divider between tree and editor to resize the tree.
      const startDrag = useCallback((e) => {
        e.preventDefault();
        draggingRef.current = true;
        const rootLeft = rootRef.current?.getBoundingClientRect().left ?? 0;
        const onMove = (ev) => {
          if (!draggingRef.current) return;
          const w = Math.min(640, Math.max(180, ev.clientX - rootLeft));
          setTreeWidth(w);
        };
        const onUp = () => {
          draggingRef.current = false;
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }, []);

      const gitBadge = (fullPath, type) => {
        if (!fullPath || type !== "file") return null;
        let rel = fullPath.replace(/\\/g, "/");
        if (rootPath) {
          const r = rootPath.replace(/\\/g, "/");
          if (rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length).replace(/^\/+/, "");
        }
        const st = gitFiles.get(rel);
        if (!st) return null;
        return jsx("span", { style: { color: gitStatusColor(st), marginLeft: 6, fontSize: 11 }, children: gitStatusLabel(st) });
      };

      // Ожидание видно всегда одинаково: кружок плюс короткая подпись.
      const spinner = (size) => jsx("span", { className: "bsl-spinner", style: { width: size || 11, height: size || 11 } });
      const loadingRow = (text) => jsxs("div", { className: "bsl-loading", children: [spinner(), jsx("span", { children: text })] });

      const renderLevel = (dirPath, depth) => {
        const list = children.get(dirPath) || [];
        return list.map((e) => {
          const isDir = e.type === "directory";
          const full = joinPath(dirPath, e.name);
          const isOpen = isDir && expanded.has(full);
          return jsxs(React.Fragment, {
            key: full,
            children: [
              jsx("div", {
                className: "dsh-bsl-row",
                "data-path": full,
                title: full,
                onClick: () => {
                  setHighlightPath(full);
                  if (isDir) toggle(full);
                  else openFile(full);
                },
                style: {
                  boxSizing: "border-box",
                  width: "100%",
                  maxWidth: "100%",
                  height: 34,
                  font: "var(--dsw-font-s-14)",
                  color: "var(--dsw-alias-label-primary)",
                  textAlign: "left",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  borderRadius: 8,
                  alignItems: "center",
                  gap: 6,
                  padding: "0 8px",
                  paddingLeft: depth * 22 + 6,
                  display: "flex",
                  background:
                    full === highlightPath
                      ? "color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent)"
                      : undefined,
                  boxShadow: full === highlightPath ? "inset 3px 0 0 var(--dsw-alias-state-business-primary)" : undefined,
                },
                children: [
                  isDir
                    ? iconBox(coloredFolder(isOpen))
                    : iconBox(coloredFile(e.name)),
                  jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: e.name }),
                  isDir && loadingDirs.has(full) ? spinner() : null,
                  gitBadge(full, e.type),
                ],
              }),
              isOpen
                ? children.has(full)
                  ? renderLevel(full, depth + 1)
                  : loadingDirs.has(full)
                  ? jsxs("div", { className: "bsl-loading", style: { paddingLeft: depth * 22 + 28 }, children: [spinner(), jsx("span", { children: "Читаем папку…" })] })
                  : null
                : null,
            ],
          });
        });
      };

      const renderSearchResults = () => {
        if (!search.trim()) return null;
        if (!searchResults.length) {
          return jsx("div", { style: { padding: "6px 10px", fontSize: 12, opacity: 0.6 }, children: "Ничего не найдено" });
        }
        if (mode === "meta") {
          // Metadata search results: { key, label, icon } → reveal in tree.
          return searchResults.map((r) => jsxs("div", {
            key: r.key ?? r.label,
            className: "dsh-bsl-row",
            onClick: () => (r.file ? (openFile(r.file), setMetaHighlight(r.file)) : revealMeta(r.key)),
            style: {
              boxSizing: "border-box", width: "100%", maxWidth: "100%", height: 34,
              font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
              textAlign: "left", cursor: "pointer", whiteSpace: "nowrap",
              borderRadius: 8, alignItems: "center", gap: 6, padding: "0 8px",
              display: "flex",
            },
            children: [
              iconBox(metaIcon(r.icon)),
              jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: r.label }),
              jsx("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.5, whiteSpace: "nowrap" }, children: r.path || r.key }),            ],
          }));
        }
        return searchResults.map((r) => {
          const isDir = r.type === "directory";
          return jsxs("div", {
            key: r.path,
            className: "dsh-bsl-row",
            title: r.path,
            onClick: () => (isDir ? reveal(r.path) : openFile(r.path)),
            style: {
              boxSizing: "border-box", width: "100%", maxWidth: "100%", height: 34,
              font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
              textAlign: "left", cursor: "pointer", whiteSpace: "nowrap",
              borderRadius: 8, alignItems: "center", gap: 6, padding: "0 8px",
              display: "flex",
            },
            children: [
              isDir
                ? iconBox(coloredFolder(true))
                : iconBox(coloredFile(r.name)),
              jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: r.name }),
              jsx("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.5, whiteSpace: "nowrap" }, children: r.rel }),
            ],
          });
        });
      };

      // Git-status filter chips: null = all files, otherwise show only files
      // with that status (M/A/??/D) as a flat list built from gitFiles.
      const gitFilterChips = [
        { key: null, label: "Все файлы" },
        { key: "*", label: "Изменённые" },
      ];
      // «??» и «A» — новый файл: показываем как «+» зелёным.
      const isNewStatus = (st) => String(st).includes("?") || String(st).trim() === "A";
      const gitStatusColor = (st) => isNewStatus(st) ? "#4caf50" : String(st).includes("D") ? "#f44336" : String(st).includes("M") ? "#e2c08d" : "#8a94a6";
      const gitStatusLabel = (st) => isNewStatus(st) ? "+" : String(st).trim();
      // "*" matches any porcelain status (incl. combined "AM"/"A?" forms).
      const statusMatches = (st, f) => f === "*" ? !!st : f === "??" ? st.includes("?") : st.split("").some((ch) => ch === f);
      const applyGitFilter = (key) => {
        // Обновляем ref синхронно: loadMeta ниже вызывается до ререндера,
        // иначе запрос уйдёт со старым значением фильтра.
        gitFilterRef.current = key;
        setGitFilter(key);
        showNotice(null);
        if (key) refreshGit();
        // Переключение фильтра в режиме метаданных: сбросить кэш дерева,
        // чтобы оно перезагрузилось с/без changed-фильтра.
        if (mode === "meta") {
          setMetaChildren(new Map());
          setMetaExpanded(new Set());
          // Эффект первичной загрузки после первого раза больше не срабатывает
          // (guard по metaInfo) — перезагружаем корень явно.
          loadMeta("");
        }
      };
      const renderGitFilter = () => jsxs("div", {
        style: { display: "flex", flexDirection: "column" },
        children: [
          jsxs("div", {
            style: { display: "flex", gap: 4, padding: "0 4px 8px" },
            children: gitFilterChips.map((c) => jsx("button", {
              onClick: () => applyGitFilter(c.key),
              style: {
                flex: 1,
                height: 22,
                padding: "0 10px",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                font: "var(--dsw-font-s-14)",
                color: "var(--dsw-alias-label-primary)",
                background: gitFilter === c.key ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                opacity: gitFilter === c.key ? 1 : 0.6,
              },
              children: c.label,
            })),
          }),
          // Работа по списку изменённых файлов: отправить в индекс всё
          // просмотренное разом и закоммитить то, что в индексе.
          gitFilter === "*" ? jsxs("div", {
            style: { display: "flex", gap: 6, padding: "0 4px 8px" },
            children: [
              jsx("button", {
                className: "bsl-hunk-btn",
                disabled: stageAllBusy,
                onClick: () => stageAllReviewed(),
                title: "Отправить в индекс просмотренные изменения всех изменённых файлов — потом их можно закоммитить",
                children: "Всё просмотренное в индекс",
              }),
              jsx("button", {
                className: "bsl-hunk-btn",
                onClick: () => (commitOpen ? closeCommitBox() : openCommitBox()),
                title: "Закоммитить то, что лежит в индексе",
                children: commitOpen ? "Отмена" : "Коммит",
              }),
            ],
          }) : null,
          commitOpen ? jsxs("div", {
            className: "bsl-commit-box",
            children: [
              commitFiles.length
                ? jsx("div", {
                    className: "bsl-commit-list",
                    children: commitFiles.map((f) => jsx("div", {
                      key: f.path,
                      className: "bsl-commit-row",
                      title: f.path,
                      children: f.path + "  +" + f.added + " -" + f.removed,
                    })),
                  })
                : jsx("div", { className: "bsl-commit-note", children: "В индексе ничего нет" }),
              jsx("textarea", {
                className: "bsl-commit-msg",
                value: commitMsg,
                placeholder: "Сообщение коммита",
                rows: 3,
                onChange: (e) => setCommitMsg(e.target.value),
              }),
              commitError ? jsx("div", { className: "bsl-commit-error", children: commitError }) : null,
              jsx("button", {
                className: "bsl-hunk-btn bsl-hunk-btn--accept",
                disabled: commitBusy || !commitMsg.trim() || !commitFiles.length,
                onClick: () => doCommit(),
                title: "Зафиксировать индекс этим сообщением",
                children: commitBusy ? "Коммитим…" : "Закоммитить",
              }),
            ],
          }) : null,
        ],
      });
      const relOf = (fullPath) => {
        let rel = fullPath.replace(/\\/g, "/");
        const r = (rootPath || "").replace(/\\/g, "/");
        if (r && rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length).replace(/^\/+/, "");
        return rel;
      };
      // Репозиторий — свойство конкретной папки проекта, поэтому инициализация живёт здесь, где
      // эта папка открыта, а не в общих настройках редактора.
      const initRepoHere = async () => {
        setGitInitBusy(true);
        try {
          await fetchJson(API_BASE + "/git-init", { method: "POST" });
          await refreshGit(true);
        } catch (e) {
          setGitInitError(String((e && e.message) || e));
        } finally {
          setGitInitBusy(false);
        }
      };
      const emptyGitText = () =>
        gitWhy === "no-git"
          ? "Git не найден — путь к git.exe указывается в Settings → 1С-Редактор кода"
          : gitWhy === "no-repo"
          ? jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
              jsx("div", { children: "Репозитория в этой папке нет: " + (rootPath || "папка проекта не открыта") }),
              jsx("div", { style: { opacity: 0.7 }, children: "Инициализация создаст git init, .gitignore (.dsh/, *.cfl, *.log) и первый коммит текущего состояния." }),
              gitInitError ? jsx("div", { style: { color: "#f48771" }, children: gitInitError }) : null,
              jsx("button", {
                className: "bsl-hunk-btn bsl-hunk-btn--accept",
                disabled: gitInitBusy || !rootPath,
                onClick: () => initRepoHere(),
                children: gitInitBusy ? "Готовим…" : "Инициализировать репозиторий",
              }),
            ]})
          : gitWhy === "status-failed"
          ? "git status не отработал: " + (gitDetail || "причина не сообщена")
          : gitDetail
          ? "Изменения не прочитаны: " + gitDetail
          : "Нет изменённых файлов";
      const renderGitList = () => {
        if (gitLoading && !gitFiles.size) return loadingRow("Читаем изменения…");
        if (!gitFiles.size) {
          return jsx("div", { style: { padding: "6px 10px", fontSize: 12, opacity: 0.6, lineHeight: 1.4 }, children: emptyGitText() });
        }
        const rows = [...gitFiles.entries()]
          .filter(([rel, st]) => statusMatches(st, gitFilter))
          .sort((a, b) => a[0].localeCompare(b[0]));
        if (!rows.length) {
          return jsx("div", { style: { padding: "6px 10px", fontSize: 12, opacity: 0.6 }, children: "Нет изменённых файлов" });
        }
        return rows.map(([rel, st]) => {
          const full = rootPath ? joinPath(rootPath, rel) : rel;
          const deleted = st.includes("D");
          const name = rel.slice(rel.lastIndexOf("/") + 1);
          return jsxs("div", {
            className: "dsh-bsl-row",
            onClick: () => (deleted ? showNotice("Файл удалён из рабочего дерева: " + rel, false, "success") : openFile(full)),
            title: full + (deleted ? " (удалён)" : "") + "  ·  " + st,
            style: {
              boxSizing: "border-box", width: "100%", maxWidth: "100%", height: 34,
              font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
              textAlign: "left", cursor: "pointer", whiteSpace: "nowrap",
              borderRadius: 8, alignItems: "center", gap: 6, padding: "0 8px",
              display: "flex",
              opacity: deleted ? 0.55 : 1,
            },
            children: [
              iconBox(coloredFile(name)),
              jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: name }),
              jsx("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: rel }),
              jsx("span", { style: { flexShrink: 0, color: gitStatusColor(st), fontSize: 11, width: 18, textAlign: "right" }, children: gitStatusLabel(st) }),
            ],
          });
        });
      };

      // 1C metadata icons come from the host's /bsl/icons route (dark set).
      // Their glyphs are near-white (#F0EFF1 on #656565), so they read only on a
      // dark surface; the .bsl-meta-icon rule below inverts their brightness for
      // the light theme.
      const metaIcon = (name) => jsx("img", {
        src: API_BASE + "/icons/" + (name || "common") + ".svg",
        className: "bsl-meta-icon",
        width: 16, height: 16,
        style: { flexShrink: 0, display: "block" },
        alt: "",
        onError: (e) => { e.currentTarget.style.visibility = "hidden"; },
      });

      const metaRowStyle = (active) => ({
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "100%",
        height: 34,
        font: "var(--dsw-font-s-14)",
        color: "var(--dsw-alias-label-primary)",
        textAlign: "left",
        cursor: "pointer",
        whiteSpace: "nowrap",
        borderRadius: 8,
        alignItems: "center",
        gap: 6,
        padding: "0 8px",
        display: "flex",
        background: active ? "var(--dsw-alias-interactive-bg-hover)" : undefined,
        boxShadow: active ? "inset 2px 0 0 var(--dsw-alias-state-business-primary)" : undefined,
      });

      const renderMetaRows = (items, depth) => (items || []).map((item) => {
        const full = item.key;
        const nodeId = full ?? item.file; // leafs highlight by their file path
        const isOpen = full != null && metaExpanded.has(full);
        const isActive = metaHighlight != null && nodeId === metaHighlight;
        const onClick = item.file
          ? () => { openFile(item.file); setMetaHighlight(nodeId); }
          : full
          ? () => { metaToggle(full); setMetaHighlight(nodeId); }
          : item.xmlFile
          ? () => {
              // Empty editor with a centered notice — no floating popup.
              if (modelRef.current) { modelRef.current.dispose?.(); modelRef.current = null; }
              if (editorRef.current) editorRef.current.setModel(null);
              showNotice("Модуль «" + item.label + "» не найден.\nОткройте XML правой кнопкой мыши.", false, "warning");
              setMetaHighlight(nodeId);
            }
          : undefined;
        const onCtx = (e) => {
          if (!item.file && !item.xmlFile) return;
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, item });
        };
        const sub = isOpen
          ? metaChildren.has(full)
            ? renderMetaLevel(full, depth + 1)
            : item.items && item.items.length
            ? renderMetaRows(item.items, depth + 1)
            : metaLoadingKey != null && metaLoadingKey === full
            ? jsxs("div", { className: "bsl-loading", style: { paddingLeft: depth * 22 + 28 }, children: [spinner(), jsx("span", { children: "Читаем раздел…" })] })
            : null
          : null;
        return jsxs(React.Fragment, {
          key: full ?? item.label + ":" + (item.file || ""),
          children: [
            jsx("div", {
              className: "dsh-bsl-row",
              "data-meta-path": nodeId ?? "",
              onClick,
              onContextMenu: onCtx,
              style: {
                ...metaRowStyle(isActive),
                paddingLeft: depth * 22 + 6,
              },
              children: [
                iconBox(metaIcon(item.icon)),
                jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: item.label }),
                item.hint ? jsx("span", { style: { marginLeft: 6, fontSize: 11, opacity: 0.55, flexShrink: 0, fontStyle: "italic" }, children: item.hint }) : null,
                item.count ? jsx("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.5 }, children: item.count }) : null,
                metaLoadingKey != null && metaLoadingKey === full ? spinner() : null,
                gitBadge(item.file, "file"),
              ],
            }),
            sub,
          ],
        });
      });

      const renderMetaLevel = (key, depth) => renderMetaRows(metaChildren.get(key) || [], depth);

      const renderMetaTree = () => {
        if (metaInfo && !metaInfo.ok) {
          return jsx("div", { style: { padding: "4px 10px", fontSize: 11, color: "#f44336", whiteSpace: "pre-wrap" }, children: "Метаданные: " + (metaInfo.error || "не найдены") });
        }
        if (metaError) {
          return jsxs("div", { style: { padding: "4px 10px", fontSize: 11, color: "#f44336", whiteSpace: "pre-wrap" }, children: [
            jsx("div", { children: "Метаданные: " + metaError }),
            // Причина «конфигурация не найдена» означает не поломку, а не ту папку:
            // без подсказки человек ищет дефект там, где его нет.
            /не найдена/i.test(metaError)
              ? jsx("div", { style: { marginTop: 4, opacity: 0.75 }, children: "Откройте папку выгрузки конфигурации (ConfigDumpInfo.xml) или проект EDT (Configuration.mdo)." })
              : null,
          ]});
        }
        if (metaLoading && !metaChildren.has("")) return loadingRow("Читаем метаданные…");
        if (!metaChildren.has("") && metaInfo == null) return loadingRow("Смотрим конфигурацию…");
        if (!metaChildren.has("")) return null;
        return renderMetaLevel("", 0);
      };

      return jsxs("div", { ref: rootRef, "data-conversation-composer-overlay": "", style: { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, width: "100%", background: "var(--dsw-alias-bg-base)", overflow: "hidden" }, children: [
        // unsaved-dot + close button per tab, global save button on the right.
        jsx("div", {
          style: {
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 4,
            height: 28,
            padding: "0 8px",
            fontSize: 11,
            color: "var(--dsw-alias-label-secondary, #8a94a6)",
            background: "var(--dsw-alias-bg-layer-2)",
            borderBottom: "1px solid var(--dsw-alias-border-l2)",
            overflowX: "auto",
            overflowY: "hidden",
            scrollbarWidth: "thin",
          },
          children: [
            // Кнопки файла (перечитать с диска / сохранить) держим в ЛЕВОМ углу
            // полосы вкладок: правый верхний угол панели занимает плашка
            // MCP-менеджера (position:absolute, top≈44px, right≈14px; её
            // положение настраивается в самом плагине, но настройка у него не
            // сохраняется) — раньше она закрывала эти кнопки. sticky left:0 —
            // чтобы кнопки не уезжали при горизонтальной прокрутке вкладок.
            openPath ? jsxs("div", { style: { position: "sticky", left: 0, zIndex: 2, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, marginRight: 8, background: "var(--dsw-alias-bg-layer-2)" }, children: [
              saveError ? jsx("span", { style: { color: "#f44336" }, title: saveError, children: "✕ ошибка сохранения" }) : null,
              jsx("button", {
                onClick: () => revertFileRef.current?.(),
                title: "Перечитать с диска — сбросить несохранённые изменения (" + openPath + ")",
                style: {
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, border: "none", borderRadius: 6,
                  cursor: "pointer", background: "transparent", color: "#8a94a6",
                  padding: 0, opacity: dirty ? 1 : 0.55,
                },
                children: jsx("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", children: [
                  jsx("polyline", { points: "23 4 23 10 17 10" }),
                  jsx("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" }),
                ] }),
              }),
              jsx("button", {
                onClick: () => saveFileRef.current?.(),
                title: saving ? "Сохранение…" : dirty ? "Сохранить (Ctrl+S) — " + openPath : "Сохранено",
                disabled: saving,
                style: {
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, border: "none", borderRadius: 6, cursor: saving ? "wait" : "pointer",
                  background: "transparent", color: dirty ? "var(--dsw-alias-state-business-primary, #4a9eff)" : "#8a94a6",
                  padding: 0, opacity: dirty || saving ? 1 : 0.55,
                },
                children: jsx("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", children: [
                  jsx("path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" }),
                  jsx("polyline", { points: "17 21 17 13 7 13 7 21" }),
                  jsx("polyline", { points: "7 3 7 8 15 8" }),
                ] }),
              }),
            ] }) : null,
            tabs.length === 0 ? jsx("span", { style: { opacity: 0.5, padding: "0 6px" }, children: "Нет открытых файлов" }) : null,
            tabs.map((p) => {
              const isTabDirty = tabDirty.has(p);
              const active = p === openPath;
              return jsxs("div", {
                onClick: () => switchTab(p),
                onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab(p); } },
                onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
                title: p + (isTabDirty ? " — есть несохранённые правки" : ""),
                style: {
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  height: 22,
                  padding: "0 6px 0 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  font: "var(--dsw-font-s-14)",
                  background: active ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                  color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary, #8a94a6)",
                  boxShadow: active ? "inset 0 -2px 0 var(--dsw-alias-state-business-primary)" : undefined,
                },
                children: [
                  jsx("span", { children: p.split(/[\\/]/).pop() }),
                  isTabDirty ? jsx("span", { title: "Не сохранён", style: { color: "#ffb300", flexShrink: 0 }, children: "●" }) : null,
                  jsx("span", {
                    onClick: (e) => { e.stopPropagation(); closeTab(p); },
                    title: "Закрыть",
                    style: {
                      flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                      width: 14, height: 14, borderRadius: 4,
                      cursor: "pointer", opacity: 0.45, fontSize: 12, lineHeight: "12px",
                    },
                    onMouseEnter: (e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)"; },
                    onMouseLeave: (e) => { e.currentTarget.style.opacity = "0.45"; e.currentTarget.style.background = "transparent"; },
                    children: "✕",
                  }),
                ],
              });
            }),
            // Принять/отклонить изменения по файлу целиком. «Отклонить все»
            // необратим для рабочей копии, поэтому выполняется вторым кликом.
            // Группа стоит последней и прижата к правому краю: вкладки идут
            // слева, поэтому от появления группы и от смены ширины счётчика они
            // не двигаются. sticky right:0 — как у кнопок файла слева, чтобы
            // группа оставалась видна при горизонтальной прокрутке вкладок.
            diffState.total > 0 ? jsxs("span", {
              style: { position: "sticky", right: 0, zIndex: 2, marginLeft: "auto", paddingLeft: 12, display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, background: "var(--dsw-alias-bg-layer-2)" },
              children: [
                jsx("button", {
                  className: "bsl-hunk-btn",
                  style: { visibility: diffState.reviewed > 0 ? "visible" : "hidden" },
                  onClick: () => toggleReviewedShow(),
                  title: diffState.show ? "Спрятать просмотренные изменения" : "Показать просмотренные изменения",
                  children: diffState.show ? "Скрыть просмотренные" : "Просмотрено: " + diffState.reviewed,
                }),
                jsx("button", {
                  className: "bsl-hunk-btn bsl-hunk-btn--reject" + (rejectAllArmed ? " bsl-hunk-btn--armed" : ""),
                  onClick: () => onRejectAllClick(),
                  title: rejectAllArmed
                    ? "Нажмите ещё раз: файл вернётся к состоянию HEAD, правки в нём пропадут"
                    : "Вернуть файл к состоянию HEAD — правки в файле пропадут",
                  children: rejectAllArmed ? "Подтвердить откат" : "Отклонить все",
                }),
                jsx("button", {
                  className: "bsl-hunk-btn bsl-hunk-btn--accept",
                  onClick: () => acceptAllHunks(),
                  title: "Отметить все изменения просмотренными — подсветка уйдёт",
                  children: "Принять все",
                }),
                jsx("button", {
                  className: "bsl-hunk-btn",
                  style: { visibility: diffState.reviewed > 0 ? "visible" : "hidden" },
                  onClick: () => stageFile(),
                  title: "Отправить просмотренные изменения в индекс — потом их можно закоммитить (в списке «Изменённые»)",
                  children: "В индекс",
                }),
              ],
            }) : null,
          ],
        }),
        jsxs("div", { style: { display: "flex", flex: 1, minHeight: 0, minWidth: 0 }, children: [
          jsxs("div", { style: { width: treeWidth, display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }, children: [
          jsxs("div", { style: { padding: "2px 6px 6px", flexShrink: 0 }, children: [
            jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "0 4px 6px" }, children: [
              jsx("div", { style: { flex: 1, minWidth: 0, fontSize: 12, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: mode === "meta"
                ? (metaInfo?.ok ? (metaInfo.configName || "Конфигурация") + " · " + (META_FORMAT_LABEL[metaInfo.format] || metaInfo.format) : "Метаданные 1С")
                : (rootTitle || "Проект") }),
              // Где открытый файл в дереве: раскрывает папки и прокручивает к нему.
              jsx("button", {
                onClick: () => showInTree(),
                title: "Показать открытый файл в дереве",
                style: {
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, border: "none", borderRadius: 6,
                  cursor: "pointer", background: "transparent", color: "#8a94a6", padding: 0,
                },
                children: jsx("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", children: [
                  jsx("circle", { cx: 12, cy: 12, r: 3 }),
                  jsx("path", { d: "M12 2v3M12 19v3M2 12h3M19 12h3" }),
                ] }),
              }),
              // Перечитать папку с диска. Без этой кнопки свежий файл появлялся
              // только в новой сессии: листинги каталогов кэшируются, а за папкой
              // никто не следит.
              jsx("button", {
                onClick: () => refreshTree(),
                disabled: refreshBusy,
                title: "Обновить дерево — прочитать папку заново",
                style: {
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, border: "none", borderRadius: 6,
                  cursor: refreshBusy ? "wait" : "pointer", background: "transparent", color: "#8a94a6",
                  padding: 0, opacity: refreshBusy ? 0.5 : 1,
                },
                children: jsx("svg", { className: refreshBusy ? "bsl-spin" : undefined, width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", children: [
                  jsx("polyline", { points: "23 4 23 10 17 10" }),
                  jsx("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" }),
                ] }),
              }),
            ]}),
            jsxs("div", { style: { display: "flex", gap: 4, padding: "0 4px 8px" }, children: [
              jsx("button", {
                onClick: () => { setMode("files"); showNotice(null); },
                style: {
                  flex: 1, height: 26, border: "none", borderRadius: 8, cursor: "pointer",
                  font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
                  background: mode === "files" ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                  opacity: mode === "files" ? 1 : 0.6,
                },
                children: "Файлы",
              }),
              jsx("button", {
                onClick: () => { setMode("meta"); showNotice(null); },
                style: {
                  flex: 1, height: 26, border: "none", borderRadius: 8, cursor: "pointer",
                  font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
                  background: mode === "meta" ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                  opacity: mode === "meta" ? 1 : 0.6,
                },
                children: "Метаданные",
              }),
            ]}),
            renderGitFilter(),
            jsx("input", {
              type: "text",
              placeholder: mode === "meta" ? "Поиск по метаданным…" : "Поиск по имени файла…",
              value: search,
              onChange: (e) => setSearch(e.target.value),
              style: {
                boxSizing: "border-box", width: "100%", height: 28,
                padding: "0 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)",
                background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)",
                font: "var(--dsw-font-s-14)", outline: "none",
              },
            }),
          ]}),
          jsx("div", { ref: treeBodyRef, style: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "0 6px 8px", paddingBottom: "calc(var(--dsh-composer-height, 152px) + 16px)" }, children: search.trim()
            ? renderSearchResults()
            : mode === "meta"
            ? renderMetaTree()
            : gitFilter
            ? renderGitList()
            : jsxs(React.Fragment, { children: [
                treeError ? jsx("div", { style: { padding: "4px 10px", fontSize: 11, color: "#f44336", whiteSpace: "pre-wrap" }, children: "Ошибка: " + treeError }) : null,
                !rootPath && !treeError ? loadingRow("Читаем папку проекта…") : null,
                renderLevel(rootPath, 0),
              ] }) }),
        ]}),
        jsx("div", {
          onMouseDown: startDrag,
          className: "dsh-bsl-resizer",
          style: { width: 4, flexShrink: 0, cursor: "col-resize", minHeight: 0 },
        }),
                jsx("div", {
                  ref: containerRef,
                  style: { flex: 1, minWidth: 0, position: "relative" },
                  // Перехватываем в фазе захвата: Monaco тоже слушает contextmenu
                  // и мог бы погасить событие до нас.
                  onContextMenuCapture: (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setCodeMenu({ x: event.clientX, y: event.clientY });
                  },
                  children: [
          !monacoReady ? jsx("div", { style: { padding: 16, opacity: 0.6, fontSize: 13, whiteSpace: "pre-wrap" }, children: monacoError ? "Ошибка загрузки редактора:\n" + monacoError : "Загрузка редактора…" }) : null,
          editorNotice ? (
            // Обе подсказки стоят сверху, под полосой вкладок: по центру поверх кода
            // они закрывали ту самую строку, к которой относились. Появляются и
            // затухают плавно. Обычная гаснет сама (NOTICE_MS) и закрывается
            // крестиком; карточка «Файл изменён на диске» с действием — ждёт
            // решения человека. Действие — синим текстом в строку, как в тосте DSH.
            noticeSticky
              ? jsx("div", { className: noticeLeaving ? "bsl-notice bsl-notice-leaving" : "bsl-notice", children:
                  jsxs("span", { className: "bsl-notice-pill", children: [
                    noticeIconElement(noticeTone),
                    jsxs("span", { className: "bsl-notice-text", children: [
                      editorNotice,
                      jsx("button", {
                        className: "bsl-notice-action",
                        onClick: () => externalReloadRef.current?.(),
                        children: "Перезагрузить с диска",
                      }),
                    ] }),
                    jsx("span", { className: "bsl-notice-close", onClick: () => closeNotice(), title: "Закрыть", children: "✕" }),
                  ] })
                })
              : jsx("div", { className: noticeLeaving ? "bsl-notice bsl-notice-leaving" : "bsl-notice", children:
                  jsxs("span", { className: "bsl-notice-pill", children: [
                    noticeIconElement(noticeTone),
                    jsx("span", { className: "bsl-notice-text", children: editorNotice }),
                    jsx("span", { className: "bsl-notice-close", onClick: () => closeNotice(), title: "Закрыть", children: "✕" }),
                  ] })
                })
          ) : null,
        ]}),
        ]}),
        ctxMenu ? jsxs(React.Fragment, { children: [
          jsx("div", { style: { position: "fixed", inset: 0, zIndex: 2147482900, background: "transparent" }, onMouseDown: () => setCtxMenu(null), onContextMenu: (e) => { e.preventDefault(); setCtxMenu(null); } }),
          jsx("div", {
            onMouseDown: (e) => e.stopPropagation(),
            style: {
              position: "fixed",
              left: Math.min(ctxMenu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 210),
              top: Math.min(ctxMenu.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 130),
              minWidth: 190,
              zIndex: 2147482901,
              background: "var(--dsw-alias-bg-layer-2)",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 10,
              boxShadow: "0 8px 30px rgba(0,0,0,.45)",
              padding: 4,
              font: "var(--dsw-font-s-14)",
              color: "var(--dsw-alias-label-primary)",
            },
            children: [
              ctxMenu.item.file ? jsx("div", { className: "dsh-bsl-menu-item", onClick: () => { openFile(ctxMenu.item.file); setCtxMenu(null); }, style: { padding: "6px 10px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }, children: "Открыть файл" }) : null,
              ctxMenu.item.xmlFile ? jsx("div", { className: "dsh-bsl-menu-item", onClick: () => { openFile(ctxMenu.item.xmlFile); setCtxMenu(null); }, style: { padding: "6px 10px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }, children: "Открыть XML" }) : null,
            ],
          }),
        ]}) : null,
        codeMenu
          ? jsxs(React.Fragment, {
              children: [
                jsx("div", {
                  style: { position: "fixed", inset: 0, zIndex: 2147482900, background: "transparent" },
                  onMouseDown: () => setCodeMenu(null),
                  onContextMenu: (event) => { event.preventDefault(); setCodeMenu(null); },
                }),
                jsx("div", {
                  onMouseDown: (event) => event.stopPropagation(),
                  style: {
                    position: "fixed",
                    left: Math.min(codeMenu.x, window.innerWidth - 250),
                    top: Math.min(codeMenu.y, window.innerHeight - 340),
                    minWidth: 230,
                    zIndex: 2147482901,
                    background: "var(--dsw-alias-bg-layer-2)",
                    border: "1px solid var(--dsw-alias-border-l2)",
                    borderRadius: 10,
                    boxShadow: "0 8px 30px rgba(0,0,0,.45)",
                    padding: 4,
                    font: "var(--dsw-font-s-14)",
                    color: "var(--dsw-alias-label-primary)",
                  },
                  children: codeMenuItems(),
                }),
              ],
            })
          : null,
      ]});
    }

    class EditorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err };
      }
      render() {
        if (this.state.err) {
          return jsx("div", {
            style: { padding: 16, color: "#f44336", fontSize: 13, whiteSpace: "pre-wrap", fontFamily: "monospace" },
            children: "RENDER ERROR: " + (this.state.err?.message || String(this.state.err)) + "\n\n" + (this.state.err?.stack || ""),
          });
        }
        return jsx(EditorView, { ...this.props });
      }
    }


/** @param {{threadId: string, environmentId: string, path?: string, lineRange?: {startLineNumber: number} | null}} props */
export function BslEditor({ threadId, environmentId, path, lineRange }) {
  const composer = useComposer();
  const sessionId = JSON.stringify([threadId, environmentId, path ?? null]);
  const request = React.useMemo(() => createEditorRequest(threadId, environmentId), [threadId, environmentId]);
  const target = React.useMemo(() => path ? { path, line: lineRange?.startLineNumber } : null, [path, lineRange]);
  return jsx(EditorBoundary, { sessionId, request, composer, target, threadId }, sessionId);
}
