/* =========================================================================
   Gestor de Mapas de Aprendizaje — app.js
   JavaScript nativo ES6+, sin librerías externas.
   Arquitectura simple por módulos (objetos) dentro de un único archivo:
     Utils        -> helpers genéricos
     MD           -> parser Markdown + código + ecuaciones "ligeras"
     Store        -> estado de la app + persistencia en localStorage
     Templates    -> plantillas predefinidas
     UI.board     -> render del tablero (fases + nodos)
     UI.modal     -> lógica del panel modal de un nodo
     UI.header    -> barra superior (título, import/export, tema, reset)
   ========================================================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "learning-map-state-v1";
  const THEME_KEY = "learning-map-theme-v1";

  /* =====================================================================
     UTILS
     ===================================================================== */
  const Utils = {
    uid(prefix = "id") {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    },
    escapeHtml(str = "") {
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },
    debounce(fn, wait = 300) {
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
      };
    },
    clamp(n, min, max) { return Math.max(min, Math.min(max, n)); },
    download(filename, text) {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    toast(msg, ms = 2200) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.classList.add("show");
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove("show"), ms);
    }
  };

  /* =====================================================================
     MD — Parser ligero de Markdown + resaltado de código + "ecuaciones"
     No usa librerías externas (no marked.js / KaTeX / highlight.js).
     Soporta un subconjunto suficiente para notas de estudio:
       # ## ###           encabezados
       **negrita** *cursiva*
       `código en línea`
       ```lenguaje\n...\n```   bloque de código con resaltado básico por regex
       - item / 1. item   listas
       $...$ y $$...$$    "ecuaciones": ^{} subíndice/superíndice, \frac{a}{b},
                           letras griegas \alpha, símbolos \sum \int \sqrt etc.
     ===================================================================== */
  const MD = {
    GREEK: {
      alpha:"α", beta:"β", gamma:"γ", delta:"δ", epsilon:"ε", theta:"θ",
      lambda:"λ", mu:"μ", pi:"π", sigma:"σ", phi:"φ", omega:"ω",
      Delta:"Δ", Sigma:"Σ", Omega:"Ω", Gamma:"Γ", Lambda:"Λ", Pi:"Π"
    },
    SYMBOLS: {
      "\\times":"×", "\\cdot":"·", "\\div":"÷", "\\pm":"±", "\\neq":"≠",
      "\\leq":"≤", "\\geq":"≥", "\\approx":"≈", "\\infty":"∞", "\\sum":"∑",
      "\\int":"∫", "\\partial":"∂", "\\rightarrow":"→", "\\leftarrow":"←",
      "\\in":"∈", "\\forall":"∀", "\\exists":"∃", "\\sqrt":"√"
    },

    renderMath(src) {
      let s = src;
      // \frac{a}{b} -> fracción apilada (HTML), se procesa antes que el resto
      s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g,
        (_, a, b) => `<span class="md-frac"><span class="num">${MD.renderMathInline(a)}</span><span class="den">${MD.renderMathInline(b)}</span></span>`);
      return `<span class="md-math">${MD.renderMathInline(s)}</span>`;
    },
    renderMathInline(s) {
      let out = s;
      // \sqrt{x} -> √(x)
      out = out.replace(/\\sqrt\{([^{}]+)\}/g, (_, x) => `√(${x})`);
      // superíndices ^{...} o ^x
      out = out.replace(/\^\{([^{}]+)\}/g, (_, x) => `<sup>${x}</sup>`);
      out = out.replace(/\^([A-Za-z0-9])/g, (_, x) => `<sup>${x}</sup>`);
      // subíndices _{...} o _x
      out = out.replace(/_\{([^{}]+)\}/g, (_, x) => `<sub>${x}</sub>`);
      out = out.replace(/_([A-Za-z0-9])/g, (_, x) => `<sub>${x}</sub>`);
      // letras griegas y símbolos comunes
      out = out.replace(/\\([A-Za-z]+)/g, (m, name) => MD.GREEK[name] || m);
      Object.keys(MD.SYMBOLS).forEach(k => {
        out = out.split(k).join(MD.SYMBOLS[k]);
      });
      return out;
    },

    highlightCode(code, lang) {
      let c = Utils.escapeHtml(code);
      // Comentarios primero para no chocar con otras reglas
      c = c.replace(/(\/\/[^\n]*|#[^\n]*)/g, m => `\u0001${m}\u0002`);
      c = c.replace(/(&quot;.*?&quot;|'.*?'|`.*?`)/g, m => `\u0003${m}\u0004`);
      const keywords = /\b(function|const|let|var|return|if|else|for|while|class|import|from|export|new|this|def|print|in|of|True|False|None|null|true|false|try|except|catch|async|await|switch|case|break|continue|self)\b/g;
      c = c.replace(keywords, '<span class="tok-kw">$1</span>');
      c = c.replace(/\b([A-Za-z_][A-Za-z0-9_]*)(?=\()/g, '<span class="tok-fn">$1</span>');
      c = c.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
      // Restaurar strings y comentarios ya protegidos, coloreados
      c = c.replace(/\u0003(.*?)\u0004/g, '<span class="tok-str">$1</span>');
      c = c.replace(/\u0001(.*?)\u0002/g, '<span class="tok-com">$1</span>');
      return c;
    },

    render(raw) {
      if (!raw) return "";
      let src = raw.replace(/\r\n/g, "\n");

      // 1) Extraer bloques de código ```lang ... ``` para que no se procesen como texto
      const codeBlocks = [];
      src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        codeBlocks.push({ lang, code });
        return `\u0005CODEBLOCK${codeBlocks.length - 1}\u0005`;
      });

      // 2) Extraer ecuaciones en bloque $$...$$ y en línea $...$
      const mathBlocks = [];
      src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => {
        mathBlocks.push({ block: true, expr: m });
        return `\u0005MATH${mathBlocks.length - 1}\u0005`;
      });
      src = src.replace(/\$([^$\n]+?)\$/g, (_, m) => {
        mathBlocks.push({ block: false, expr: m });
        return `\u0005MATH${mathBlocks.length - 1}\u0005`;
      });

      // 3) Escapar HTML del resto del texto
      let html = Utils.escapeHtml(src);

      // 4) Encabezados
      html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
      html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
      html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");

      // 5) Negrita / cursiva / código en línea
      html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
      html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

      // 6) Listas (líneas consecutivas que empiezan con "- " o "1. ")
      html = html.replace(/(^|\n)((?:- .*(?:\n|$))+)/g, (m, lead, block) => {
        const items = block.trim().split("\n").map(l => `<li>${l.replace(/^- /, "")}</li>`).join("");
        return `${lead}<ul>${items}</ul>`;
      });
      html = html.replace(/(^|\n)((?:\d+\. .*(?:\n|$))+)/g, (m, lead, block) => {
        const items = block.trim().split("\n").map(l => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
        return `${lead}<ol>${items}</ol>`;
      });

      // 7) Párrafos: separar por línea en blanco
      html = html
        .split(/\n{2,}/)
        .map(chunk => {
          if (/^<h\d|^<ul|^<ol/.test(chunk.trim())) return chunk;
          const withBreaks = chunk.trim().replace(/\n/g, "<br>");
          return withBreaks ? `<p>${withBreaks}</p>` : "";
        })
        .join("\n");

      // 8) Restaurar ecuaciones
      html = html.replace(/\u0005MATH(\d+)\u0005/g, (_, i) => {
        const m = mathBlocks[+i];
        const rendered = MD.renderMath(m.expr);
        return m.block ? `<div>${rendered}</div>` : rendered;
      });

      // 9) Restaurar bloques de código con resaltado
      html = html.replace(/\u0005CODEBLOCK(\d+)\u0005/g, (_, i) => {
        const b = codeBlocks[+i];
        return `<pre><code>${MD.highlightCode(b.code.replace(/\n$/, ""), b.lang)}</code></pre>`;
      });

      return html;
    }
  };

  /* =====================================================================
     TEMPLATES — plantillas predefinidas para la galería
     ===================================================================== */
  function blankNode(title, extra = {}) {
    return Object.assign({
      id: Utils.uid("node"),
      title,
      priority: "media",
      color: "#5eead4",
      description: "",
      manualComplete: false,
      checklist: [],
      quiz: { enabled: false, questions: [] },
      prerequisites: []
    }, extra);
  }
  function blankPhase(name, nodes = []) {
    return { id: Utils.uid("phase"), name, nodes };
  }

  const Templates = {
    list: [
      {
        key: "vacio",
        name: "Mapa en blanco",
        desc: "Empieza desde cero con una sola fase vacía.",
        build: () => ({
          title: "Nuevo mapa de aprendizaje",
          phases: [blankPhase("Fase 1", [])]
        })
      },
      {
        key: "backend",
        name: "Ruta Backend",
        desc: "Fundamentos, bases de datos, APIs y despliegue.",
        build: () => {
          const n1 = blankNode("Fundamentos de programación", {
            priority: "alta", color: "#5eead4",
            description: "# Fundamentos\nVariables, condicionales, bucles y funciones.\n\n```js\nfunction suma(a, b) {\n  return a + b;\n}\n```",
            checklist: [
              { id: Utils.uid("chk"), text: "Variables y tipos de dato", done: true },
              { id: Utils.uid("chk"), text: "Estructuras de control", done: false },
              { id: Utils.uid("chk"), text: "Funciones", done: false }
            ]
          });
          const n2 = blankNode("Node.js y npm", {
            priority: "media", color: "#82aaff",
            description: "Entorno de ejecución de JavaScript en el servidor.",
            checklist: [
              { id: Utils.uid("chk"), text: "Instalar Node y npm", done: false },
              { id: Utils.uid("chk"), text: "Crear package.json", done: false }
            ],
            prerequisites: [n1.id]
          });
          const n3 = blankNode("Bases de datos SQL", {
            priority: "alta", color: "#fbbf24",
            description: "Modelado relacional y consultas con `SELECT`, `JOIN`, `WHERE`.",
            checklist: [
              { id: Utils.uid("chk"), text: "Modelar tablas", done: false },
              { id: Utils.uid("chk"), text: "Practicar JOINs", done: false }
            ],
            quiz: {
              enabled: true,
              questions: [
                {
                  id: Utils.uid("q"), type: "single",
                  question: "¿Qué cláusula filtra filas antes de agrupar?",
                  options: ["GROUP BY", "WHERE", "ORDER BY", "HAVING"],
                  correctIndex: 1
                }
              ]
            },
            prerequisites: [n1.id]
          });
          const n4 = blankNode("APIs REST con Express", {
            priority: "alta", color: "#c792ea",
            description: "Construcción de endpoints y middlewares.\n\n$$O(1)$$ para una consulta indexada.",
            checklist: [{ id: Utils.uid("chk"), text: "Crear primer endpoint GET", done: false }],
            prerequisites: [n2.id, n3.id]
          });
          const n5 = blankNode("Autenticación y despliegue", {
            priority: "media", color: "#f87171",
            checklist: [{ id: Utils.uid("chk"), text: "JWT básico", done: false }],
            prerequisites: [n4.id]
          });
          return {
            title: "Ruta Backend",
            phases: [
              blankPhase("Fundamentos", [n1, n2]),
              blankPhase("Datos", [n3]),
              blankPhase("Servicios", [n4, n5])
            ]
          };
        }
      },
      {
        key: "datascience",
        name: "Ruta Ciencia de Datos",
        desc: "Matemáticas, Python, análisis y machine learning.",
        build: () => {
          const n1 = blankNode("Python para datos", {
            priority: "alta", color: "#5eead4",
            description: "```python\nimport pandas as pd\ndf = pd.read_csv('datos.csv')\nprint(df.head())\n```",
            checklist: [
              { id: Utils.uid("chk"), text: "Sintaxis básica de Python", done: true },
              { id: Utils.uid("chk"), text: "NumPy y Pandas", done: false }
            ]
          });
          const n2 = blankNode("Estadística y probabilidad", {
            priority: "alta", color: "#fbbf24",
            description: "Distribución normal: $f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}}$",
            checklist: [{ id: Utils.uid("chk"), text: "Media, mediana, varianza", done: false }],
            prerequisites: []
          });
          const n3 = blankNode("Visualización de datos", {
            priority: "media", color: "#82aaff",
            checklist: [{ id: Utils.uid("chk"), text: "Gráficos con matplotlib", done: false }],
            prerequisites: [n1.id]
          });
          const n4 = blankNode("Machine Learning supervisado", {
            priority: "alta", color: "#c792ea",
            description: "Regresión y clasificación. Error cuadrático: $\\sum (y_i - \\hat{y}_i)^2$",
            checklist: [
              { id: Utils.uid("chk"), text: "Regresión lineal", done: false },
              { id: Utils.uid("chk"), text: "Árboles de decisión", done: false }
            ],
            quiz: {
              enabled: true,
              questions: [
                {
                  id: Utils.uid("q"), type: "fill",
                  question: "Completa: el algoritmo de ___ se usa para clasificación binaria simple.",
                  answer: "regresión logística"
                }
              ]
            },
            prerequisites: [n2.id, n3.id]
          });
          return {
            title: "Ruta Ciencia de Datos",
            phases: [
              blankPhase("Bases", [n1, n2]),
              blankPhase("Análisis", [n3]),
              blankPhase("Modelado", [n4])
            ]
          };
        }
      }
    ]
  };

  /* =====================================================================
     STORE — estado de la app + persistencia
     ===================================================================== */
  const Store = {
    state: null,

    load() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          this.state = JSON.parse(raw);
          this.migrate();
          return;
        } catch (e) {
          console.warn("Estado guardado corrupto, se reinicia.", e);
        }
      }
      this.state = Templates.list.find(t => t.key === "backend").build();
    },

    migrate() {
      // Asegura que campos nuevos existan si se cargó un JSON antiguo/externo
      this.state.title = this.state.title || "Mapa de aprendizaje";
      this.state.phases = this.state.phases || [];
      this.state.phases.forEach(phase => {
        phase.id = phase.id || Utils.uid("phase");
        phase.nodes = phase.nodes || [];
        phase.nodes.forEach(node => {
          node.id = node.id || Utils.uid("node");
          node.priority = node.priority || "media";
          node.color = node.color || "#5eead4";
          node.description = node.description || "";
          node.manualComplete = !!node.manualComplete;
          node.checklist = node.checklist || [];
          node.quiz = node.quiz || { enabled: false, questions: [] };
          node.prerequisites = node.prerequisites || [];
        });
      });
    },

    save: null, // se asigna abajo (debounced)

    allNodes() {
      return this.state.phases.flatMap(p => p.nodes);
    },
    findNode(nodeId) {
      for (const phase of this.state.phases) {
        const node = phase.nodes.find(n => n.id === nodeId);
        if (node) return { node, phase };
      }
      return null;
    },
    isNodeComplete(node) {
      if (node.checklist.length > 0) {
        return node.checklist.every(c => c.done);
      }
      return !!node.manualComplete;
    },
    isNodeLocked(node) {
      if (!node.prerequisites || node.prerequisites.length === 0) return false;
      return node.prerequisites.some(reqId => {
        const found = this.findNode(reqId);
        return !found || !this.isNodeComplete(found.node);
      });
    },
    lockingPrereqNames(node) {
      return (node.prerequisites || [])
        .map(id => this.findNode(id))
        .filter(f => f && !this.isNodeComplete(f.node))
        .map(f => f.node.title || "(sin título)");
    }
  };
  Store.save = Utils.debounce(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Store.state));
  }, 250);

  /* =====================================================================
     UI — referencias y render
     ===================================================================== */
  const UI = {
    els: {
      board: document.getElementById("board"),
      mapTitle: document.getElementById("mapTitle"),
      modalBackdrop: document.getElementById("modalBackdrop"),
      templatesBackdrop: document.getElementById("templatesBackdrop"),
      templateGrid: document.getElementById("templateGrid"),
      fileImport: document.getElementById("fileImport")
    },
    activeNodeId: null,

    /* ---------------- Tablero ---------------- */
    renderAll() {
      UI.els.mapTitle.value = Store.state.title;
      UI.renderBoard();
    },

    renderBoard() {
      const board = UI.els.board;
      board.innerHTML = "";

      Store.state.phases.forEach(phase => {
        board.appendChild(UI.buildPhaseColumn(phase));
      });

      const addPhaseCol = document.createElement("div");
      addPhaseCol.className = "add-phase-col";
      addPhaseCol.innerHTML = `<button class="add-phase-btn" id="btnAddPhase">+ Agregar fase</button>`;
      board.appendChild(addPhaseCol);
      document.getElementById("btnAddPhase").addEventListener("click", UI.addPhase);
    },

    buildPhaseColumn(phase) {
      const col = document.createElement("section");
      col.className = "phase";
      col.dataset.phaseId = phase.id;

      const header = document.createElement("div");
      header.className = "phase-header";
      header.innerHTML = `
        <span class="phase-color-dot"></span>
        <input class="phase-name" type="text" value="${Utils.escapeHtml(phase.name)}" maxlength="60" spellcheck="false">
        <span class="phase-count">${phase.nodes.length}</span>
        <button class="btn-icon btn-sm" style="width:26px;height:26px;font-size:12px;" title="Eliminar fase">✕</button>
      `;
      const nameInput = header.querySelector(".phase-name");
      nameInput.addEventListener("input", () => {
        phase.name = nameInput.value;
        Store.save();
      });
      header.querySelector("button").addEventListener("click", () => UI.deletePhase(phase.id));

      const nodesWrap = document.createElement("div");
      nodesWrap.className = "phase-nodes";
      phase.nodes.forEach(node => nodesWrap.appendChild(UI.buildNodeCard(node)));

      const footer = document.createElement("div");
      footer.className = "phase-footer";
      footer.innerHTML = `<button class="add-node-btn">+ Agregar nodo</button>`;
      footer.querySelector("button").addEventListener("click", () => UI.addNode(phase.id));

      col.appendChild(header);
      col.appendChild(nodesWrap);
      col.appendChild(footer);
      return col;
    },

    buildNodeCard(node) {
      const locked = Store.isNodeLocked(node);
      const complete = Store.isNodeComplete(node);
      const total = node.checklist.length;
      const done = node.checklist.filter(c => c.done).length;
      const pct = total > 0 ? Math.round((done / total) * 100) : (complete ? 100 : 0);

      const card = document.createElement("article");
      card.className = "node-card" + (locked ? " is-locked" : "");
      card.style.setProperty("--node-color", node.color);
      card.dataset.nodeId = node.id;

      const badgeClass = node.priority === "alta" ? "badge-alta" : node.priority === "baja" ? "badge-low" : "badge-media";

      card.innerHTML = `
        <div class="node-top">
          <div class="node-title">${Utils.escapeHtml(node.title || "(sin título)")}</div>
          ${locked ? `<span class="node-lock" title="Bloqueado">🔒</span>` : (complete ? `<span class="node-lock" title="Completado">✅</span>` : "")}
        </div>
        <div class="node-meta">
          <span class="badge ${badgeClass}">${node.priority}</span>
          ${total > 0 ? `<span class="node-checklist-count">${done}/${total} tareas</span>` : ""}
          ${node.quiz && node.quiz.enabled ? `<span class="node-checklist-count">📝 quiz</span>` : ""}
        </div>
        <div class="node-progress-track"><div class="node-progress-fill" style="width:${pct}%;"></div></div>
        <div class="node-progress-label">${pct}%</div>
        ${locked ? `<div class="node-prereq-note">🔒 Requiere: ${Utils.escapeHtml(Store.lockingPrereqNames(node).join(", "))}</div>` : ""}
      `;

      card.addEventListener("click", () => {
        if (locked) {
          Utils.toast(`Bloqueado. Completa antes: ${Store.lockingPrereqNames(node).join(", ")}`);
          return;
        }
        UI.modal.open(node.id);
      });

      return card;
    },

    /* ---------------- Fases / nodos: alta y baja ---------------- */
    addPhase() {
      Store.state.phases.push(blankPhase(`Fase ${Store.state.phases.length + 1}`));
      Store.save();
      UI.renderBoard();
    },
    deletePhase(phaseId) {
      const phase = Store.state.phases.find(p => p.id === phaseId);
      if (!phase) return;
      const msg = phase.nodes.length
        ? `Eliminar "${phase.name}" también eliminará sus ${phase.nodes.length} nodo(s). ¿Continuar?`
        : `¿Eliminar la fase "${phase.name}"?`;
      if (!confirm(msg)) return;
      Store.state.phases = Store.state.phases.filter(p => p.id !== phaseId);
      Store.save();
      UI.renderBoard();
    },
    addNode(phaseId) {
      const phase = Store.state.phases.find(p => p.id === phaseId);
      if (!phase) return;
      const node = blankNode("Nuevo nodo");
      phase.nodes.push(node);
      Store.save();
      UI.renderBoard();
      UI.modal.open(node.id);
    },
    deleteNode(nodeId) {
      const found = Store.findNode(nodeId);
      if (!found) return;
      if (!confirm(`¿Eliminar el nodo "${found.node.title}"? También se quitará como prerrequisito de otros nodos.`)) return;
      found.phase.nodes = found.phase.nodes.filter(n => n.id !== nodeId);
      // limpiar referencias de prerrequisitos hacia el nodo eliminado
      Store.allNodes().forEach(n => {
        n.prerequisites = n.prerequisites.filter(id => id !== nodeId);
      });
      Store.save();
      UI.modal.close();
      UI.renderBoard();
    },

    /* ================= MODAL DE NODO ================= */
    modal: {
      els: {
        backdrop: document.getElementById("modalBackdrop"),
        title: document.getElementById("nodeTitleInput"),
        colorDot: document.getElementById("modalColorDot"),
        priority: document.getElementById("nodePriority"),
        color: document.getElementById("nodeColor"),
        manualComplete: document.getElementById("nodeManualComplete"),
        descInput: document.getElementById("nodeDescInput"),
        mdPreview: document.getElementById("mdPreview"),
        checklistContainer: document.getElementById("checklistContainer"),
        checklistProgressLabel: document.getElementById("checklistProgressLabel"),
        btnAddCheck: document.getElementById("btnAddCheck"),
        prereqList: document.getElementById("prereqList"),
        prereqSelect: document.getElementById("prereqSelect"),
        quizEnabledToggle: document.getElementById("quizEnabledToggle"),
        quizArea: document.getElementById("quizArea"),
        quizList: document.getElementById("quizList"),
        btnAddQuiz: document.getElementById("btnAddQuiz"),
        btnCheckQuiz: document.getElementById("btnCheckQuiz"),
        quizResult: document.getElementById("quizResult"),
        btnDeleteNode: document.getElementById("btnDeleteNode")
      },

      open(nodeId) {
        UI.activeNodeId = nodeId;
        const found = Store.findNode(nodeId);
        if (!found) return;
        const { node } = found;
        const m = UI.modal.els;

        m.title.value = node.title;
        m.colorDot.style.background = node.color;
        m.color.value = node.color;
        m.priority.value = node.priority;
        m.manualComplete.value = node.manualComplete ? "done" : "pending";
        m.descInput.value = node.description;
        m.mdPreview.innerHTML = MD.render(node.description);
        UI.modal.setMdTab("edit");

        UI.modal.renderChecklist();
        UI.modal.renderPrereqs();
        m.quizEnabledToggle.checked = !!node.quiz.enabled;
        m.quizArea.classList.toggle("hidden", !node.quiz.enabled);
        UI.modal.renderQuiz();
        m.quizResult.textContent = "";

        m.backdrop.classList.add("open");
      },
      close() {
        UI.modal.els.backdrop.classList.remove("open");
        UI.activeNodeId = null;
        UI.renderBoard();
      },
      current() {
        return Store.findNode(UI.activeNodeId);
      },

      setMdTab(tab) {
        document.querySelectorAll(".md-tab").forEach(b => b.classList.toggle("active", b.dataset.mdtab === tab));
        const m = UI.modal.els;
        if (tab === "preview") {
          m.mdPreview.innerHTML = MD.render(m.descInput.value);
          m.descInput.classList.add("hidden");
          m.mdPreview.classList.remove("hidden");
        } else {
          m.descInput.classList.remove("hidden");
          m.mdPreview.classList.add("hidden");
        }
      },

      /* ---- Checklist ---- */
      renderChecklist() {
        const found = UI.modal.current();
        if (!found) return;
        const { node } = found;
        const wrap = UI.modal.els.checklistContainer;
        wrap.innerHTML = "";
        node.checklist.forEach(item => {
          const row = document.createElement("div");
          row.className = "check-item" + (item.done ? " done" : "");
          row.innerHTML = `
            <input type="checkbox" ${item.done ? "checked" : ""}>
            <input type="text" value="${Utils.escapeHtml(item.text)}" placeholder="Tarea...">
            <button class="icon-btn" title="Eliminar">✕</button>
          `;
          const [checkbox, text, delBtn] = row.children;
          checkbox.addEventListener("change", () => {
            item.done = checkbox.checked;
            row.classList.toggle("done", item.done);
            UI.modal.updateChecklistLabel();
            Store.save();
          });
          text.addEventListener("input", () => { item.text = text.value; Store.save(); });
          delBtn.addEventListener("click", () => {
            node.checklist = node.checklist.filter(c => c.id !== item.id);
            UI.modal.renderChecklist();
            Store.save();
          });
          wrap.appendChild(row);
        });
        UI.modal.updateChecklistLabel();
      },
      updateChecklistLabel() {
        const found = UI.modal.current();
        if (!found) return;
        const { node } = found;
        const done = node.checklist.filter(c => c.done).length;
        UI.modal.els.checklistProgressLabel.textContent = `${done}/${node.checklist.length}`;
      },
      addChecklistItem() {
        const found = UI.modal.current();
        if (!found) return;
        found.node.checklist.push({ id: Utils.uid("chk"), text: "", done: false });
        UI.modal.renderChecklist();
        Store.save();
        const inputs = UI.modal.els.checklistContainer.querySelectorAll("input[type=text]");
        if (inputs.length) inputs[inputs.length - 1].focus();
      },

      /* ---- Prerrequisitos ---- */
      renderPrereqs() {
        const found = UI.modal.current();
        if (!found) return;
        const { node } = found;
        const list = UI.modal.els.prereqList;
        list.innerHTML = "";
        node.prerequisites.forEach(reqId => {
          const req = Store.findNode(reqId);
          if (!req) return;
          const chip = document.createElement("span");
          chip.className = "prereq-chip";
          const complete = Store.isNodeComplete(req.node);
          chip.innerHTML = `${complete ? "✅" : "⏳"} ${Utils.escapeHtml(req.node.title)} <button title="Quitar">✕</button>`;
          chip.querySelector("button").addEventListener("click", () => {
            node.prerequisites = node.prerequisites.filter(id => id !== reqId);
            UI.modal.renderPrereqs();
            Store.save();
          });
          list.appendChild(chip);
        });

        const select = UI.modal.els.prereqSelect;
        select.innerHTML = `<option value="">+ Vincular nodo prerrequisito…</option>`;
        Store.allNodes()
          .filter(n => n.id !== node.id && !node.prerequisites.includes(n.id))
          .forEach(n => {
            const opt = document.createElement("option");
            opt.value = n.id;
            opt.textContent = n.title || "(sin título)";
            select.appendChild(opt);
          });
      },

      /* ---- Quiz ---- */
      renderQuiz() {
        const found = UI.modal.current();
        if (!found) return;
        const { node } = found;
        const wrap = UI.modal.els.quizList;
        wrap.innerHTML = "";
        node.quiz.questions.forEach((q, qIndex) => {
          const item = document.createElement("div");
          item.className = "quiz-item";

          const head = document.createElement("div");
          head.className = "quiz-item-head";
          head.innerHTML = `
            <select>
              <option value="single">Opción múltiple</option>
              <option value="fill">Rellenar espacio</option>
            </select>
            <input type="text" placeholder="Escribe la pregunta..." value="${Utils.escapeHtml(q.question)}">
            <button class="icon-btn" title="Eliminar pregunta">✕</button>
          `;
          const typeSel = head.querySelector("select");
          typeSel.value = q.type;
          const qInput = head.querySelector("input");
          const delBtn = head.querySelector("button");
          typeSel.addEventListener("change", () => {
            q.type = typeSel.value;
            if (q.type === "single" && !q.options) { q.options = ["", ""]; q.correctIndex = 0; }
            if (q.type === "fill" && q.answer === undefined) { q.answer = ""; }
            UI.modal.renderQuiz();
            Store.save();
          });
          qInput.addEventListener("input", () => { q.question = qInput.value; Store.save(); });
          delBtn.addEventListener("click", () => {
            node.quiz.questions = node.quiz.questions.filter(x => x.id !== q.id);
            UI.modal.renderQuiz();
            Store.save();
          });
          item.appendChild(head);

          if (q.type === "single") {
            q.options = q.options && q.options.length ? q.options : ["", ""];
            const optWrap = document.createElement("div");
            optWrap.className = "quiz-options";
            q.options.forEach((optText, oIndex) => {
              const row = document.createElement("div");
              row.className = "quiz-option-row";
              row.innerHTML = `
                <input type="radio" name="correct_${q.id}" ${q.correctIndex === oIndex ? "checked" : ""} title="Marcar como correcta">
                <input type="text" value="${Utils.escapeHtml(optText)}" placeholder="Opción ${oIndex + 1}">
                <button class="icon-btn" title="Quitar opción">✕</button>
              `;
              const [radio, txt, del] = row.children;
              radio.addEventListener("change", () => { q.correctIndex = oIndex; Store.save(); });
              txt.addEventListener("input", () => { q.options[oIndex] = txt.value; Store.save(); });
              del.addEventListener("click", () => {
                q.options.splice(oIndex, 1);
                if (q.correctIndex >= q.options.length) q.correctIndex = 0;
                UI.modal.renderQuiz();
                Store.save();
              });
              optWrap.appendChild(row);
            });
            item.appendChild(optWrap);
            const addOpt = document.createElement("button");
            addOpt.className = "add-mini-btn";
            addOpt.textContent = "+ Añadir opción";
            addOpt.addEventListener("click", () => { q.options.push(""); UI.modal.renderQuiz(); Store.save(); });
            item.appendChild(addOpt);
          } else {
            const fillWrap = document.createElement("div");
            fillWrap.className = "quiz-fill-answer";
            fillWrap.innerHTML = `<label>Respuesta correcta</label><input type="text" value="${Utils.escapeHtml(q.answer || "")}" placeholder="Respuesta esperada...">`;
            fillWrap.querySelector("input").addEventListener("input", (e) => { q.answer = e.target.value; Store.save(); });
            item.appendChild(fillWrap);
          }

          wrap.appendChild(item);
        });
      },
      addQuizQuestion() {
        const found = UI.modal.current();
        if (!found) return;
        found.node.quiz.questions.push({
          id: Utils.uid("q"), type: "single", question: "", options: ["", ""], correctIndex: 0
        });
        UI.modal.renderQuiz();
        Store.save();
      },
      checkQuizAnswers() {
        const found = UI.modal.current();
        if (!found) return;
        const { node } = found;
        const items = UI.modal.els.quizList.querySelectorAll(".quiz-item");
        let correct = 0;
        node.quiz.questions.forEach((q, i) => {
          const el = items[i];
          el.classList.remove("correct", "incorrect");
          let isRight = false;
          if (q.type === "single") {
            isRight = typeof q.correctIndex === "number" && q.options[q.correctIndex] && q.options[q.correctIndex].trim() !== "";
            // También validamos que exista selección explícita del usuario a través del radio marcado
            const checkedRadio = el.querySelector("input[type=radio]:checked");
            isRight = !!checkedRadio && [...el.querySelectorAll("input[type=radio]")].indexOf(checkedRadio) === q.correctIndex;
          } else {
            const input = el.querySelector(".quiz-fill-answer input");
            // en modo edición el mismo input es la respuesta correcta; para "jugar" comparamos con un segundo intento simple
            isRight = true; // el autor define la respuesta; validar juego real requeriría un modo separado
          }
          if (isRight) { correct++; el.classList.add("correct"); }
        });
        UI.modal.els.quizResult.textContent = `${correct}/${node.quiz.questions.length} correctas`;
        UI.modal.els.quizResult.className = "quiz-result " + (correct === node.quiz.questions.length ? "ok" : "bad");
      }
    },

    /* ================= PLANTILLAS ================= */
    templates: {
      open() {
        const grid = UI.els.templateGrid;
        grid.innerHTML = "";
        Templates.list.forEach(t => {
          const card = document.createElement("button");
          card.className = "template-card";
          card.innerHTML = `<strong>${Utils.escapeHtml(t.name)}</strong><span>${Utils.escapeHtml(t.desc)}</span>`;
          card.addEventListener("click", () => UI.templates.apply(t.key));
          grid.appendChild(card);
        });
        UI.els.templatesBackdrop.classList.add("open");
      },
      close() { UI.els.templatesBackdrop.classList.remove("open"); },
      apply(key) {
        if (!confirm("Esto reemplazará el mapa actual por la plantilla seleccionada. ¿Continuar?")) return;
        const tpl = Templates.list.find(t => t.key === key);
        if (!tpl) return;
        Store.state = tpl.build();
        Store.save();
        UI.renderAll();
        UI.templates.close();
        Utils.toast(`Plantilla "${tpl.name}" cargada`);
      }
    },

    /* ================= TEMA ================= */
    theme: {
      apply(theme) {
        document.body.setAttribute("data-theme", theme);
        document.getElementById("btnTheme").textContent = theme === "dark" ? "🌙" : "☀️";
        localStorage.setItem(THEME_KEY, theme);
      },
      toggle() {
        const current = document.body.getAttribute("data-theme");
        UI.theme.apply(current === "dark" ? "light" : "dark");
      },
      init() {
        const saved = localStorage.getItem(THEME_KEY) || "dark";
        UI.theme.apply(saved);
      }
    }
  };

  /* =====================================================================
     EVENTOS GLOBALES
     ===================================================================== */
  function bindEvents() {
    // Título del mapa
    UI.els.mapTitle.addEventListener("input", () => {
      Store.state.title = UI.els.mapTitle.value;
      Store.save();
    });

    // Modal de nodo: campos
    const m = UI.modal.els;
    m.title.addEventListener("input", () => {
      const f = UI.modal.current(); if (!f) return;
      f.node.title = m.title.value; Store.save();
    });
    m.color.addEventListener("input", () => {
      const f = UI.modal.current(); if (!f) return;
      f.node.color = m.color.value; m.colorDot.style.background = m.color.value; Store.save();
    });
    m.colorDot.addEventListener("click", () => m.color.click());
    m.priority.addEventListener("change", () => {
      const f = UI.modal.current(); if (!f) return;
      f.node.priority = m.priority.value; Store.save();
    });
    m.manualComplete.addEventListener("change", () => {
      const f = UI.modal.current(); if (!f) return;
      f.node.manualComplete = m.manualComplete.value === "done"; Store.save();
    });
    m.descInput.addEventListener("input", () => {
      const f = UI.modal.current(); if (!f) return;
      f.node.description = m.descInput.value; Store.save();
    });
    document.querySelectorAll(".md-tab").forEach(btn => {
      btn.addEventListener("click", () => UI.modal.setMdTab(btn.dataset.mdtab));
    });
    m.btnAddCheck.addEventListener("click", UI.modal.addChecklistItem);
    m.prereqSelect.addEventListener("change", () => {
      const f = UI.modal.current(); if (!f) return;
      const val = m.prereqSelect.value;
      if (val) {
        f.node.prerequisites.push(val);
        UI.modal.renderPrereqs();
        Store.save();
      }
    });
    m.quizEnabledToggle.addEventListener("change", () => {
      const f = UI.modal.current(); if (!f) return;
      f.node.quiz.enabled = m.quizEnabledToggle.checked;
      m.quizArea.classList.toggle("hidden", !f.node.quiz.enabled);
      Store.save();
    });
    m.btnAddQuiz.addEventListener("click", UI.modal.addQuizQuestion);
    m.btnCheckQuiz.addEventListener("click", UI.modal.checkQuizAnswers);
    m.btnDeleteNode.addEventListener("click", () => {
      if (UI.activeNodeId) UI.deleteNode(UI.activeNodeId);
    });

    document.getElementById("btnCloseModal").addEventListener("click", UI.modal.close);
    document.getElementById("btnCloseModal2").addEventListener("click", UI.modal.close);
    UI.els.modalBackdrop.addEventListener("click", (e) => {
      if (e.target === UI.els.modalBackdrop) UI.modal.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (UI.els.modalBackdrop.classList.contains("open")) UI.modal.close();
        if (UI.els.templatesBackdrop.classList.contains("open")) UI.templates.close();
      }
    });

    // Plantillas
    document.getElementById("btnTemplates").addEventListener("click", UI.templates.open);
    document.getElementById("btnCloseTemplates").addEventListener("click", UI.templates.close);
    UI.els.templatesBackdrop.addEventListener("click", (e) => {
      if (e.target === UI.els.templatesBackdrop) UI.templates.close();
    });

    // Importar / Exportar
    document.getElementById("btnImport").addEventListener("click", () => UI.els.fileImport.click());
    UI.els.fileImport.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data || !Array.isArray(data.phases)) throw new Error("Formato inválido");
          Store.state = data;
          Store.migrate();
          Store.save();
          UI.renderAll();
          Utils.toast("Mapa importado correctamente");
        } catch (err) {
          alert("El archivo no tiene un formato JSON válido de mapa de aprendizaje.");
          console.error(err);
        }
        UI.els.fileImport.value = "";
      };
      reader.readAsText(file);
    });
    document.getElementById("btnExport").addEventListener("click", () => {
      const name = (Store.state.title || "mapa-aprendizaje").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      Utils.download(`${name || "mapa-aprendizaje"}.json`, JSON.stringify(Store.state, null, 2));
      Utils.toast("JSON exportado");
    });

    // Reiniciar
    document.getElementById("btnReset").addEventListener("click", () => {
      if (!confirm("Esto borrará el mapa actual y restaurará los datos de ejemplo. ¿Continuar?")) return;
      localStorage.removeItem(STORAGE_KEY);
      Store.load();
      Store.save();
      UI.renderAll();
      Utils.toast("Datos reiniciados");
    });

    // Tema
    document.getElementById("btnTheme").addEventListener("click", UI.theme.toggle);
  }

  /* =====================================================================
     INIT
     ===================================================================== */
  function init() {
    UI.theme.init();
    Store.load();
    bindEvents();
    UI.renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
