"use strict";

/*
 * Cas Zéro – clinical case simulator engine.
 * All logic and state is in English. All text shown to the student comes
 * from French JSON files:
 *   - data/interface.json  : texts shared by every case (buttons, messages)
 *   - data/cas-*.json      : one file per clinical case (see GUIDE-NOUVEAU-CAS.md)
 */

const INDEX_URL = "data/cas-index.json";
const INTERFACE_URL = "data/interface.json";
const STORAGE_PREFIX = "cas-zero-best-score:";
const MAX_SCORE = 100;
const DEFAULT_HINT_PENALTY = 2;
const DEFAULT_DIAGNOSIS_ATTEMPTS = 3;
const FUZZY_MIN_LENGTH = 6;
const TYPING_BASE_MS = 450;
const TYPING_MS_PER_CHAR = 7;
const TYPING_MAX_MS = 1600;
const LOAD_ERROR_FALLBACK = "Impossible de charger le cas clinique. Ouvrez l'application depuis un serveur web (Vercel ou npx serve).";

const STEP_KEYS = [
  "etape1_anamnese",
  "etape2_examen_physique",
  "etape3_paraclinique",
  "etape4_diagnostic",
  "etape5_traitement",
  "etape6_debriefing"
];

function createRun() {
  return {
    events: [],            // score changes: { step, label, delta }
    anamnesis: null,       // history-taking session (items, questions, communication)
    missedDiagnoses: []    // diagnoses revealed instead of found
  };
}

const state = {
  caseData: null, // clinical case JSON
  ui: null,       // shared interface JSON
  score: 0,
  stepIndex: -1,
  bestScore: 0,
  run: createRun()
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function $(selector) {
  return document.querySelector(selector);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Replace {name} placeholders in a French template. */
function formatText(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    values && values[key] !== undefined ? values[key] : match
  ));
}

/** Lowercase, strip accents/punctuation so "Céphalées" matches "cepha". */
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/œ/g, "oe")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function editDistance(a, b) {
  const previous = [];
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length];
}

/**
 * Position of a keyword inside normalized text, or -1.
 * - Short keywords (<= 3 chars, e.g. "pl", "ge") must match a whole word,
 *   so "pl" does not match "plasmodium". A leading "=" forces a whole-word
 *   match for longer keywords too ("=ains" does not match "certains").
 * - Longer single-word keywords tolerate small typos (1 letter, or 2 when
 *   the keyword has 10+ letters).
 */
function findKeyword(normalizedText, keyword) {
  const wholeWord = String(keyword).charAt(0) === "=";
  const key = normalize(wholeWord ? String(keyword).slice(1) : keyword);
  if (!key) return -1;
  if (wholeWord || key.length <= 3) {
    const match = new RegExp("(^| )" + key + "( |$)").exec(normalizedText);
    return match ? match.index + match[1].length : -1;
  }
  const exact = normalizedText.indexOf(key);
  if (exact !== -1) return exact;
  if (key.length >= FUZZY_MIN_LENGTH && key.indexOf(" ") === -1) {
    const maxDistance = key.length >= 10 ? 2 : 1;
    let offset = 0;
    const tokens = normalizedText.split(" ");
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (Math.abs(token.length - key.length) <= maxDistance && editDistance(token, key) <= maxDistance) {
        return offset;
      }
      offset += token.length + 1;
    }
  }
  return -1;
}

function hasKeyword(text, keywords) {
  const normalized = normalize(text);
  return keywords.some((keyword) => findKeyword(normalized, keyword) !== -1);
}

/** True if a negation ("pas de", "sans", "éviter"...) comes right before the keyword. */
function isNegated(normalizedText, index) {
  const before = normalizedText.slice(Math.max(0, index - 30), index);
  return /(^| )(pas|sans|eviter|jamais|non|interdit|contre indique)( |$)/.test(before);
}

/** Fatal keyword present and not negated. */
function containsFatalKeyword(text, keywords) {
  const normalized = normalize(text);
  return keywords.some((keyword) => {
    const index = findKeyword(normalized, keyword);
    return index !== -1 && !isNegated(normalized, index);
  });
}

function getRule(name, fallback) {
  const rules = state.caseData.regles || {};
  return rules[name] !== undefined ? rules[name] : fallback;
}

/* ------------------------------------------------------------------ */
/* Anamnesis engine (pure functions, no DOM: easy to test)            */
/* ------------------------------------------------------------------ */

const MAX_ANSWERS_PER_QUESTION = 3;
const OPEN_QUESTION_REVEAL_COUNT = 2;

/**
 * Build the history-taking items of a case:
 * - standard questions (data/interface.json), answered by the case or, when the
 *   case says nothing, by a normal default answer;
 * - questions specific to the case (defined in the case file).
 * Items are sorted by rubric, then sub-rubric.
 */
function buildAnamnesisItems(step, config) {
  const standard = config.questionsStandard || {};
  const provided = {};
  (step.elements || []).forEach((element) => { provided[element.id] = element; });
  const items = [];

  function addItem(id, base, element, isStandard) {
    const answer = element.reponse !== undefined ? element.reponse : base.defaut;
    if (!answer) return; // no answer defined: the question does not exist in this case
    items.push({
      id,
      rubrique: element.rubrique || base.rubrique,
      sousRubrique: element.sousRubrique !== undefined ? element.sousRubrique : (base.sousRubrique || null),
      libelle: element.libelle || base.libelle || id,
      questionExemple: element.questionExemple || base.questionExemple || "",
      pourquoi: element.pourquoi || base.pourquoi || "",
      keywords: (base.motsCles || []).concat(element.motsCles || []),
      exclusions: (base.exclusions || []).concat(element.exclusions || []),
      reponse: answer,
      fromDefault: element.reponse === undefined,
      note: element.note || base.noteDefaut || answer,
      pertinence: element.pertinence || (isStandard ? "systematique" : "utile"),
      inclut: element.inclut || [],
      aValider: Boolean(element.aValider),
      standard: isStandard,
      revealed: false,
      question: null
    });
  }

  Object.keys(standard).forEach((id) => addItem(id, standard[id], provided[id] || {}, true));
  (step.elements || []).forEach((element) => {
    if (!standard[element.id]) addItem(element.id, {}, element, false);
  });

  const rubriques = config.rubriques || [];
  function rank(item) {
    const r = rubriques.findIndex((rubrique) => rubrique.id === item.rubrique);
    const subs = r >= 0 ? (rubriques[r].sousRubriques || []) : [];
    const s = subs.findIndex((sub) => sub.id === item.sousRubrique);
    return (r < 0 ? 99 : r) * 100 + (s < 0 ? 0 : s);
  }
  items.forEach((item, index) => { item.position = index; });
  items.sort((a, b) => (rank(a) - rank(b)) || (a.position - b.position));
  return items;
}

/**
 * Items whose keywords appear in the student's question.
 * An item is skipped when one of its "exclusions" also appears (e.g. a question
 * about family history must not trigger the personal history answer).
 */
function matchAnamnesisItems(items, text) {
  const normalized = normalize(text);
  const found = (keyword) => findKeyword(normalized, keyword) !== -1;
  return items.filter((item) => item.keywords.some(found) && !(item.exclusions || []).some(found));
}

/** Which communication behaviours (greeting, introduction, empathy, summary) the message shows. */
function detectCommunication(text, config) {
  const lists = (config.communication && config.communication.motsCles) || {};
  const result = {};
  Object.keys(lists).forEach((name) => { result[name] = hasKeyword(text, lists[name]); });
  return result;
}

/** Dynamic hint: points at a rubric the student has not explored yet. */
function buildAnamnesisHint(items, config, step) {
  const rubriques = config.rubriques || [];
  const titleOf = (id) => {
    const found = rubriques.find((rubrique) => rubrique.id === id);
    return found ? found.titre : id;
  };
  const keyItems = items.filter((item) => item.pertinence === "cle");
  const untouched = rubriques.find((rubrique) => {
    const inRubric = keyItems.filter((item) => item.rubrique === rubrique.id);
    return inRubric.length > 0 && inRubric.every((item) => !item.revealed);
  });
  if (untouched) {
    return formatText(config.indice.rubrique, { rubrique: untouched.titre }) + (step.aide ? " " + step.aide : "");
  }
  const missing = keyItems.find((item) => !item.revealed);
  if (missing) return formatText(config.indice.element, { rubrique: titleOf(missing.rubrique) });
  return config.indice.complet;
}

/* ------------------------------------------------------------------ */
/* Score                                                              */
/* ------------------------------------------------------------------ */

/** Apply a score change (negative = penalty) and record it for the debriefing. */
function changeScore(delta, label) {
  const previous = state.score;
  state.score = Math.max(0, Math.min(MAX_SCORE, previous + delta));
  const applied = state.score - previous;
  if (label && delta !== 0) {
    state.run.events.push({ step: state.stepIndex, label, delta });
  }
  renderScore();
  if (applied !== 0) showToast(applied);
}

function renderScore() {
  $("#scoreValue").textContent = String(state.score);
  const box = $("#score");
  box.classList.remove("low", "critical");
  if (state.score < 40) box.classList.add("critical");
  else if (state.score < 70) box.classList.add("low");
  box.classList.remove("bump");
  void box.offsetWidth; // restart animation
  box.classList.add("bump");
}

function showToast(applied) {
  const toast = el("div", "toast " + (applied > 0 ? "plus" : "minus"),
    (applied > 0 ? "+" : "") + applied);
  $("#toastLayer").append(toast);
  setTimeout(() => toast.remove(), 1700);
}

/* ------------------------------------------------------------------ */
/* Top bar                                                            */
/* ------------------------------------------------------------------ */

function buildTracker() {
  const tracker = $("#tracker");
  tracker.innerHTML = "";
  state.ui.etapesCourtes.forEach((name, index) => {
    const item = el("li");
    item.append(el("span", "dot", String(index + 1)), el("span", "name", name));
    tracker.append(item);
  });
  $("#scoreLabel").textContent = state.ui.labelScore;
}

function renderTracker() {
  const items = $("#tracker").children;
  Array.from(items).forEach((item, index) => {
    item.classList.toggle("done", index < state.stepIndex);
    item.classList.toggle("current", index === state.stepIndex);
  });
  const progress = Math.max(0, state.stepIndex) / (STEP_KEYS.length - 1);
  $("#progressFill").style.width = Math.round(progress * 100) + "%";
  const currentName = $("#currentName");
  if (currentName) currentName.textContent = state.ui.etapesCourtes[state.stepIndex] || "";
}

/* ------------------------------------------------------------------ */
/* Vital signs monitor (always visible: ECG trace + live values)      */
/* ------------------------------------------------------------------ */

const MONITOR_REFRESH_MS = 2000;
const ECG_SWEEP_SPEED = 90;   // pixels per second
const ECG_ERASE_GAP = 14;     // pixels erased ahead of the moving trace
const ALARM_DURATION_MS = 3500;
const MAX_SPO2 = 100;
const ECG_COLOR = "#22c55e";

// Maximum drift (+/-) around the case values, one entry per parsed number.
const VITAL_DRIFT = {
  frequenceCardiaque: [3],
  tension: [4, 3],
  saturation: [1],
  frequenceRespiratoire: [1],
  temperature: [0.3],
  glycemieCapillaire: [0] // capillary glucose is a spot measurement: it stays fixed
};

const VITAL_STEP = { temperature: 0.1 };

const VITAL_COLORS = {
  frequenceCardiaque: "#22c55e",
  tension: "#f87171",
  saturation: "#38bdf8",
  frequenceRespiratoire: "#facc15",
  temperature: "#fb923c",
  glycemieCapillaire: "#c084fc"
};

/** Case vitals completed with normal default values, in monitor order. */
function getVitals() {
  const defaults = state.ui.constantesParDefaut || {};
  const given = state.caseData.etapes.etape2_examen_physique.constantes || {};
  const merged = Object.assign({}, defaults, given);
  const ordered = {};
  state.ui.moniteur.ordre.forEach((key) => {
    if (merged[key] !== undefined) ordered[key] = merged[key];
  });
  Object.keys(merged).forEach((key) => {
    if (ordered[key] === undefined) ordered[key] = merged[key];
  });
  return ordered;
}

const monitor = {
  built: false,
  running: false,
  vitals: {},   // key -> { base: number[], current: number[] }
  fields: {},   // key -> value element
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  x: 0,
  prevY: 0,
  beatPhase: 0,
  lastFrame: 0,
  refreshTimer: null,
  alarmTimer: null
};

function parseVitalNumbers(text) {
  const found = String(text).match(/\d+(?:[.,]\d+)?/g) || [];
  return found.map((value) => parseFloat(value.replace(",", ".")));
}

function formatVital(key, value) {
  return key === "temperature" ? value.toFixed(1).replace(".", ",") : String(value);
}

function buildMonitor() {
  const config = state.ui.moniteur;
  const constants = getVitals();
  const root = $("#monitor");
  root.innerHTML = "";
  root.setAttribute("aria-label", config.titre);

  const inner = el("div", "monitor-inner");
  const ecgBox = el("div", "monitor-ecg");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  ecgBox.append(canvas);

  const values = el("div", "monitor-values");
  monitor.vitals = {};
  monitor.fields = {};
  config.ordre.forEach((key) => {
    if (constants[key] === undefined) return;
    const numbers = parseVitalNumbers(constants[key]);
    if (numbers.length === 0) return;
    monitor.vitals[key] = { base: numbers, current: numbers.slice() };

    const cell = el("div", "monitor-cell");
    cell.style.setProperty("--vital-color", VITAL_COLORS[key] || "#e5e7eb");
    const value = el("span", "monitor-value");
    cell.append(
      el("span", "monitor-label", config.libelles[key] || key),
      value,
      el("span", "monitor-unit", config.unites[key] || "")
    );
    monitor.fields[key] = value;
    values.append(cell);
  });

  inner.append(ecgBox, values);
  root.append(inner);
  monitor.canvas = canvas;
  monitor.ctx = canvas.getContext("2d");
  monitor.built = true;
  renderMonitorValues();
  window.addEventListener("resize", resizeEcg);
}

function renderMonitorValues() {
  Object.keys(monitor.vitals).forEach((key) => {
    monitor.fields[key].textContent = monitor.vitals[key].current
      .map((value) => formatVital(key, value))
      .join("/");
  });
}

/** Small random walk around the case values so the monitor feels alive. */
function refreshVitals() {
  Object.keys(monitor.vitals).forEach((key) => {
    const vital = monitor.vitals[key];
    const drift = VITAL_DRIFT[key] || [0];
    const stepSize = VITAL_STEP[key] || 1;
    vital.current = vital.current.map((value, index) => {
      const limit = drift[index] || 0;
      if (!limit) return value;
      const delta = (Math.floor(Math.random() * 3) - 1) * stepSize;
      let next = Math.max(vital.base[index] - limit, Math.min(vital.base[index] + limit, value + delta));
      next = Math.round(next * 10) / 10;
      if (key === "saturation") next = Math.min(next, MAX_SPO2);
      return next;
    });
  });
  renderMonitorValues();
}

function resizeEcg() {
  const canvas = monitor.canvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  monitor.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  monitor.width = rect.width;
  monitor.height = rect.height;
  monitor.x = 0;
  monitor.prevY = rect.height * 0.72;
}

function gaussian(x, center, width) {
  const delta = x - center;
  return Math.exp(-(delta * delta) / (2 * width * width));
}

/** Synthetic P-QRS-T shape for a beat phase between 0 and 1 (R peak = 1). */
function ecgSample(phase) {
  return 0.12 * gaussian(phase, 0.16, 0.025)
    - 0.15 * gaussian(phase, 0.285, 0.009)
    + 1.0 * gaussian(phase, 0.31, 0.011)
    - 0.28 * gaussian(phase, 0.34, 0.011)
    + 0.3 * gaussian(phase, 0.58, 0.05);
}

function pulseHeartRate() {
  const field = monitor.fields.frequenceCardiaque;
  if (!field) return;
  field.classList.remove("beat");
  void field.offsetWidth; // restart animation
  field.classList.add("beat");
}

function drawEcg(dt) {
  const ctx = monitor.ctx;
  const width = monitor.width;
  const height = monitor.height;
  const heartRate = monitor.vitals.frequenceCardiaque ? monitor.vitals.frequenceCardiaque.current[0] : 80;
  const beatPeriod = 60 / heartRate;
  const steps = Math.max(1, Math.round(dt * ECG_SWEEP_SPEED));
  const phaseStep = (dt / steps) / beatPeriod;
  const baseline = height * 0.72;
  const amplitude = height * 0.62;

  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.strokeStyle = ECG_COLOR;

  for (let i = 0; i < steps; i += 1) {
    monitor.beatPhase += phaseStep;
    if (monitor.beatPhase >= 1) {
      monitor.beatPhase -= 1;
      pulseHeartRate();
    }
    const y = baseline - ecgSample(monitor.beatPhase) * amplitude;
    const nextX = monitor.x + 1;
    if (nextX >= width) {
      monitor.x = 0;
      monitor.prevY = y;
      ctx.clearRect(0, 0, ECG_ERASE_GAP, height);
      continue;
    }
    ctx.clearRect(nextX, 0, ECG_ERASE_GAP, height);
    ctx.beginPath();
    ctx.moveTo(monitor.x, monitor.prevY);
    ctx.lineTo(nextX, y);
    ctx.stroke();
    monitor.x = nextX;
    monitor.prevY = y;
  }
}

function ecgFrame(now) {
  if (!monitor.running) return;
  const dt = Math.min(Math.max((now - monitor.lastFrame) / 1000, 0), 0.1);
  monitor.lastFrame = now;
  if (monitor.ctx && monitor.width > 0 && dt > 0) drawEcg(dt);
  requestAnimationFrame(ecgFrame);
}

function startMonitor() {
  if (!monitor.built || monitor.running) return;
  $("#monitor").hidden = false;
  resizeEcg();
  monitor.running = true;
  monitor.lastFrame = performance.now();
  monitor.refreshTimer = setInterval(refreshVitals, MONITOR_REFRESH_MS);
  requestAnimationFrame(ecgFrame);
}

function flashMonitorAlarm() {
  const root = $("#monitor");
  root.classList.add("alarm");
  clearTimeout(monitor.alarmTimer);
  monitor.alarmTimer = setTimeout(() => root.classList.remove("alarm"), ALARM_DURATION_MS);
}

/* ------------------------------------------------------------------ */
/* Step shell (card + chat + form + buttons)                          */
/* ------------------------------------------------------------------ */

function createShell(step, options) {
  const ui = state.ui;
  const stage = $("#stage");
  stage.innerHTML = "";

  const card = el("section", "card step-card enter");
  const head = el("div", "step-head");
  head.append(
    el("span", "step-chip", (state.stepIndex + 1) + "/" + STEP_KEYS.length),
    el("h1", "step-title", step.titre)
  );
  card.append(head);
  if (options.instruction) card.append(el("p", "instruction", options.instruction));
  if (options.extra) card.append(options.extra);

  const chat = el("div", "chat");
  card.append(chat);

  const shell = {
    card,
    chat,
    onSubmit: null,
    onNext: null,
    helpUsed: false,
    nextButton: null,
    actions: null
  };

  shell.addMessage = (kind, text, title) => {
    const bubble = el("div", "msg msg-" + kind);
    if (title) bubble.append(el("span", "msg-title", title));
    bubble.append(document.createTextNode(text));
    chat.append(bubble);
    bubble.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (kind === "danger") {
      card.classList.remove("shake");
      void card.offsetWidth;
      card.classList.add("shake");
    }
    return bubble;
  };

  shell.addBlock = (node) => {
    chat.append(node);
    return node;
  };

  if (options.withForm !== false) {
    const form = el("form", "form");
    form.setAttribute("autocomplete", "off");
    const input = el("input", "input");
    input.type = "text";
    input.placeholder = options.placeholder || "";
    input.setAttribute("aria-label", options.placeholder || "");
    const send = el("button", "btn btn-blue", ui.boutonEnvoyer);
    send.type = "submit";
    form.append(input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value || !shell.onSubmit) return;
      input.value = "";
      shell.onSubmit(value);
    });
    card.append(form);
    shell.input = input;
  }

  const actions = el("div", "actions");
  shell.actions = actions;

  if (step.aide) {
    const penalty = getRule("penaliteAide", DEFAULT_HINT_PENALTY);
    const help = el("button", "btn btn-ghost", ui.boutonAide);
    help.type = "button";
    help.append(el("span", "penalty", "-" + penalty));
    help.addEventListener("click", () => {
      if (shell.helpUsed) return;
      shell.helpUsed = true;
      changeScore(-penalty, ui.journal.aide);
      shell.addMessage("hint", options.hint ? options.hint() : step.aide, ui.libellesMessages.indice);
      shell.addMessage("warn", formatText(ui.messages.aideUtilisee, { points: penalty }));
      help.disabled = true;
    });
    actions.append(help);
  }

  const next = el("button", "btn btn-primary", ui.boutonContinuer);
  next.type = "button";
  next.hidden = true;
  next.addEventListener("click", () => {
    if (!shell.onNext || shell.onNext() !== false) goToStep(state.stepIndex + 1);
  });
  actions.append(next);
  shell.nextButton = next;
  shell.showNext = () => { next.hidden = false; };

  card.append(actions);
  stage.append(card);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (shell.input) shell.input.focus({ preventScroll: true });
  return shell;
}

function createBlock(title, text, className) {
  const block = el("div", "block" + (className ? " " + className : ""));
  block.append(el("h3", null, title));
  if (text !== undefined) block.append(el("p", null, text));
  return block;
}

/* ------------------------------------------------------------------ */
/* Step 1 – history taking                                            */
/* ------------------------------------------------------------------ */

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function renderAnamnesis(step) {
  const ui = state.ui;
  const config = ui.anamnese;
  const items = buildAnamnesisItems(step, config);
  const byId = {};
  items.forEach((item) => { byId[item.id] = item; });

  const session = {
    items,
    questions: [],
    communication: { salutation: false, presentation: false, empathie: false, synthese: false },
    greeted: false,
    variant: 0
  };
  state.run.anamnesis = session;
  let active = true;
  let confirmBlock = null;

  const nextVariant = (list) => {
    const choice = list[session.variant % list.length];
    session.variant += 1;
    return choice;
  };

  // Notebook: notes taken during the interview, grouped by rubric
  const notebook = el("details", "notebook");
  const notebookCount = el("span", "notebook-count");
  const notebookSummary = el("summary", "notebook-summary");
  notebookSummary.append(el("span", "notebook-title", config.carnet.titre), notebookCount);
  const notebookBody = el("div", "notebook-body");
  notebook.append(notebookSummary, notebookBody);

  function renderNotebook() {
    const taken = items.filter((item) => item.revealed);
    notebookCount.textContent = formatText(config.carnet.compteur, { n: taken.length });
    notebookBody.innerHTML = "";
    if (taken.length === 0) {
      notebookBody.append(el("p", "notebook-empty", config.carnet.vide));
      return;
    }
    config.rubriques.forEach((rubrique) => {
      const notes = taken.filter((item) => item.rubrique === rubrique.id);
      const section = el("div", "notebook-section");
      section.append(el("h4", null, rubrique.titre));
      if (notes.length === 0) {
        section.append(el("p", "notebook-empty", "—"));
      } else {
        const list = el("ul");
        notes.forEach((item) => list.append(el("li", null, item.note)));
        section.append(list);
      }
      notebookBody.append(section);
    });
  }
  renderNotebook();

  const shell = createShell(step, {
    instruction: ui.consignes.etape1_anamnese,
    placeholder: ui.placeholders.etape1_anamnese,
    extra: notebook,
    hint: () => buildAnamnesisHint(items, config, step)
  });

  shell.addMessage("scene", step.presentationInitiale);
  if (step.accueil) shell.addMessage("sim", step.accueil, ui.libellesMessages.famille);

  /** The family "types" for a moment, then answers. */
  function respond(texts) {
    const typing = el("div", "msg msg-sim msg-typing");
    typing.setAttribute("aria-label", config.ecrit);
    typing.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
    shell.chat.append(typing);
    typing.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (shell.input) shell.input.disabled = true;
    const length = texts.join(" ").length;
    const delay = prefersReducedMotion() ? 0 : Math.min(TYPING_MAX_MS, TYPING_BASE_MS + length * TYPING_MS_PER_CHAR);
    setTimeout(() => {
      typing.remove();
      if (!active) return;
      texts.forEach((text) => shell.addMessage("sim", text, ui.libellesMessages.famille));
      renderNotebook();
      if (shell.input) {
        shell.input.disabled = false;
        shell.input.focus({ preventScroll: true });
      }
    }, delay);
  }

  function reveal(item, question) {
    item.revealed = true;
    item.question = question;
  }

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);

    const detected = detectCommunication(text, config);
    Object.keys(detected).forEach((name) => {
      if (detected[name]) session.communication[name] = true;
    });

    const replies = [];
    if ((detected.salutation || detected.presentation) && !session.greeted) {
      session.greeted = true;
      replies.push(nextVariant(config.reponses.salutation));
    }

    const candidates = matchAnamnesisItems(items, text);
    let fresh = candidates.filter((item) => !item.revealed);
    const alreadyKnown = candidates.filter((item) => item.revealed);

    // Too many questions at once: the family only answers the first ones.
    let overflow = false;
    if (fresh.length > MAX_ANSWERS_PER_QUESTION) {
      fresh = fresh.slice(0, MAX_ANSWERS_PER_QUESTION);
      overflow = true;
    }

    // A vague open question ("racontez-moi") makes the family tell the story.
    const isOpenQuestion = hasKeyword(text, config.questionsOuvertes || []);
    if (fresh.length === 0 && alreadyKnown.length === 0 && isOpenQuestion) {
      fresh = (step.recitSpontane || [])
        .map((id) => byId[id])
        .filter((item) => item && !item.revealed)
        .slice(0, OPEN_QUESTION_REVEAL_COUNT);
    }

    fresh.forEach((item) => {
      reveal(item, text);
      item.inclut.forEach((id) => {
        if (byId[id] && !byId[id].revealed) reveal(byId[id], text);
      });
    });
    session.questions.push({ text, ids: fresh.map((item) => item.id) });

    if (fresh.length > 0) {
      replies.push(fresh.map((item) => item.reponse).join(" "));
    } else if (replies.length === 0) {
      replies.push(nextVariant(alreadyKnown.length > 0 || isOpenQuestion ? config.reponses.dejaDit : config.reponses.nonCompris));
    }
    if (overflow) replies.push(nextVariant(config.reponses.tropDeQuestions));

    respond(replies);
  };

  // The student decides when the history is complete (remarks come at the debriefing).
  shell.nextButton.textContent = config.boutonTerminer;
  shell.showNext();
  shell.onNext = () => {
    if (confirmBlock) return false;
    confirmBlock = el("div", "msg msg-warn confirm-block");
    confirmBlock.append(el("span", "confirm-text", config.confirmation.texte));
    const buttons = el("div", "confirm-actions");
    const yes = el("button", "btn btn-primary", config.confirmation.oui);
    yes.type = "button";
    yes.addEventListener("click", () => {
      active = false;
      goToStep(state.stepIndex + 1);
    });
    const no = el("button", "btn btn-ghost", config.confirmation.non);
    no.type = "button";
    no.addEventListener("click", () => {
      confirmBlock.remove();
      confirmBlock = null;
      if (shell.input) shell.input.focus();
    });
    buttons.append(yes, no);
    confirmBlock.append(buttons);
    shell.addBlock(confirmBlock);
    confirmBlock.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return false;
  };
}

/* ------------------------------------------------------------------ */
/* Step 2 – physical exam                                             */
/* ------------------------------------------------------------------ */

function renderPhysicalExam(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: ui.consignes.etape2_examen_physique,
    placeholder: ui.placeholders.etape2_examen_physique
  });

  // Vital signs
  const vitalsBlock = createBlock(ui.libellesBlocs.constantes);
  const grid = el("div", "vitals");
  Object.entries(getVitals()).forEach(([key, value]) => {
    const cell = el("div", "vital");
    cell.append(
      el("span", "k", ui.libellesConstantes[key] || key),
      el("span", "v", String(value))
    );
    grid.append(cell);
  });
  vitalsBlock.append(grid);
  shell.addBlock(vitalsBlock);

  shell.addBlock(createBlock(ui.libellesBlocs.examenGeneral, step.examenGeneral));
  shell.addBlock(createBlock(ui.libellesBlocs.examenSystemes, step.examenSystemes));

  const neuro = step.examenNeurologique;
  const neuroBlock = createBlock(ui.libellesBlocs.examenNeurologique, ui.libellesBlocs.nonRealise, "locked");
  shell.addBlock(neuroBlock);
  let neuroDone = false;

  function revealNeuro() {
    neuroDone = true;
    neuroBlock.classList.remove("locked");
    neuroBlock.classList.add("revealed");
    neuroBlock.querySelector("p").textContent = neuro.resultats;
    neuroBlock.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);
    if (hasKeyword(text, neuro.demandeRequise)) {
      if (neuroDone) {
        shell.addMessage("warn", ui.messages.examenDejaFait);
      } else {
        revealNeuro();
        shell.addMessage("good", ui.messages.examenNeuroDemande);
        shell.showNext();
      }
    } else {
      shell.addMessage("warn", ui.messages.examenNonReconnu);
    }
  };

  // Leaving without the neurological exam costs points, then reveals it.
  shell.onNext = () => {
    if (neuroDone) return true;
    changeScore(-neuro.malusSiOubli, ui.journal.neuroOublie);
    revealNeuro();
    shell.addMessage("danger", formatText(ui.messages.examenNeuroOublie, { points: neuro.malusSiOubli }));
    return false; // stay one more moment so the student reads the result
  };
  shell.showNext();
}

/* ------------------------------------------------------------------ */
/* Step 3 – paraclinical work-up                                      */
/* ------------------------------------------------------------------ */

function renderParaclinical(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: step.question,
    placeholder: ui.placeholders.etape3_paraclinique
  });

  const priorityExams = Object.keys(step.examensValides).map((key) =>
    Object.assign({ key }, step.examensValides[key]));
  const acceptableExams = step.examensAcceptables || [];
  const foundKeys = new Set();
  const doneAcceptable = new Set();
  const penalizedInputs = new Set();
  const penalizedPrerequisites = new Set();
  let completeAnnounced = false;

  /** An exam with a prerequisite needs at least one exam of the required group first. */
  function prerequisiteMet(exam) {
    if (!exam.prerequis) return true;
    return priorityExams.some((other) =>
      other.groupeAlternatif === exam.prerequis.groupe && foundKeys.has(other.key));
  }

  /** Complete = every standalone exam found + one exam of each alternative group. */
  function isComplete() {
    const groups = {};
    for (let i = 0; i < priorityExams.length; i += 1) {
      const exam = priorityExams[i];
      if (exam.groupeAlternatif) {
        groups[exam.groupeAlternatif] = groups[exam.groupeAlternatif] || foundKeys.has(exam.key);
      } else if (!foundKeys.has(exam.key)) {
        return false;
      }
    }
    return Object.keys(groups).every((group) => groups[group]);
  }

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);
    let matchedAny = false;

    // Exams with a prerequisite are handled last, so "scanner puis PL" in one message works.
    const ordered = priorityExams.filter((exam) => !exam.prerequis)
      .concat(priorityExams.filter((exam) => exam.prerequis));

    ordered.forEach((exam) => {
      if (!hasKeyword(text, exam.motsCles)) return;
      matchedAny = true;
      if (foundKeys.has(exam.key)) {
        shell.addMessage("warn", ui.messages.examenDejaFait);
        return;
      }
      if (!prerequisiteMet(exam)) {
        let message = exam.prerequis.message;
        if (!penalizedPrerequisites.has(exam.key)) {
          penalizedPrerequisites.add(exam.key);
          changeScore(-exam.prerequis.malus, exam.prerequis.libelleJournal);
          message += " " + formatText(ui.messages.prerequisPenalite, { points: exam.prerequis.malus });
        }
        shell.addMessage("danger", message);
        return;
      }
      foundKeys.add(exam.key);
      shell.addMessage("sim", exam.resultat, exam.libelle || ui.libellesMessages.resultat);
    });

    acceptableExams.forEach((exam) => {
      if (!hasKeyword(text, exam.motsCles)) return;
      matchedAny = true;
      if (doneAcceptable.has(exam.nom)) {
        shell.addMessage("warn", ui.messages.examenDejaFait);
        return;
      }
      doneAcceptable.add(exam.nom);
      shell.addMessage("sim", exam.resultat || ui.messages.examenNonPrioritaire, exam.nom);
      if (exam.malus > 0) changeScore(-exam.malus, ui.journal.examenInutile + " : " + exam.nom);
    });

    if (!matchedAny) {
      const normalized = normalize(text);
      if (normalized.length >= 2 && !penalizedInputs.has(normalized)) {
        penalizedInputs.add(normalized);
        changeScore(-step.malusExamenInutile, ui.journal.examenInutile);
        shell.addMessage("danger", formatText(ui.messages.examenInutile, { points: step.malusExamenInutile }));
      } else {
        shell.addMessage("warn", ui.messages.examenNonReconnu);
      }
    }

    if (isComplete() && !completeAnnounced) {
      completeAnnounced = true;
      shell.addMessage("good", ui.messages.bilanComplet);
      shell.showNext();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Step 4 – diagnosis                                                 */
/* ------------------------------------------------------------------ */

function renderDiagnosis(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: step.question,
    placeholder: ui.placeholders.etape4_diagnostic
  });

  const expected = step.diagnosticsAttendus;
  const attemptsBeforeReveal = getRule("tentativesDiagnosticAvantReponse", DEFAULT_DIAGNOSIS_ATTEMPTS);
  const foundDiagnoses = new Set();
  let failedAttempts = 0;
  let revealButton = null;
  let answerRevealed = false;

  const expectedNames = () => expected.map((diagnosis) => diagnosis.nom).join(", ");

  function finish() {
    if (revealButton) revealButton.hidden = true;
    shell.showNext();
  }

  function revealAnswer() {
    answerRevealed = true;
    shell.addMessage("sim", ui.messages.diagnosticsReponse + " " + expectedNames());
    let totalLost = 0;
    expected.forEach((diagnosis) => {
      if (foundDiagnoses.has(diagnosis.nom)) return;
      totalLost += diagnosis.points;
      state.run.missedDiagnoses.push(diagnosis.nom);
      changeScore(-diagnosis.points, ui.journal.diagnosticManque + " : " + diagnosis.nom);
    });
    if (totalLost > 0) {
      shell.addMessage("warn", formatText(ui.messages.diagnosticsPenalite, { points: totalLost }));
    }
    finish();
  }

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);

    if (answerRevealed) {
      shell.addMessage("warn", ui.messages.diagnosticsReponse + " " + expectedNames());
      return;
    }

    let matchedAny = false;
    let newlyFound = false;

    expected.forEach((diagnosis) => {
      if (!hasKeyword(text, diagnosis.motsCles || [diagnosis.nom])) return;
      matchedAny = true;
      if (foundDiagnoses.has(diagnosis.nom)) {
        shell.addMessage("warn", ui.messages.diagnosticDejaTrouve + " " + diagnosis.nom);
      } else {
        foundDiagnoses.add(diagnosis.nom);
        newlyFound = true;
        shell.addMessage("good", ui.messages.diagnosticTrouve + " " + diagnosis.nom);
      }
    });

    if (!matchedAny) {
      failedAttempts += 1;
      shell.addMessage("warn", ui.messages.diagnosticIncorrect);
      if (failedAttempts >= attemptsBeforeReveal && !revealButton) {
        revealButton = el("button", "btn btn-ghost", ui.boutonVoirReponse);
        revealButton.type = "button";
        revealButton.addEventListener("click", revealAnswer);
        shell.actions.prepend(revealButton);
      }
    }

    if (newlyFound && foundDiagnoses.size === expected.length) {
      shell.addMessage("good", ui.messages.diagnosticsComplets);
      finish();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Step 5 – treatment                                                 */
/* ------------------------------------------------------------------ */

function renderTreatment(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: ui.consignes.etape5_traitement,
    placeholder: ui.placeholders.etape5_traitement
  });

  const groups = step.groupesTraitement;
  const coveredGroups = new Set();
  const fatal = step.erreursFatales;
  const penalizedFatalInputs = new Set();

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);

    // Fatal error always takes priority over correct items in the same answer.
    if (containsFatalKeyword(text, fatal.motsCles)) {
      const normalized = normalize(text);
      if (!penalizedFatalInputs.has(normalized)) {
        penalizedFatalInputs.add(normalized);
        changeScore(-fatal.punition, ui.journal.erreurFatale);
        flashMonitorAlarm();
      }
      shell.addMessage("danger", fatal.message, formatText(ui.messages.erreurFataleTitre, { points: fatal.punition }));
      return;
    }

    let matchedAny = false;
    groups.forEach((group) => {
      if (!hasKeyword(text, group.motsCles)) return;
      matchedAny = true;
      if (!coveredGroups.has(group.libelle)) {
        coveredGroups.add(group.libelle);
        shell.addMessage("good", ui.messages.traitementTrouve + " " + group.libelle);
      }
    });

    if (coveredGroups.size === groups.length) {
      shell.addMessage("good", ui.messages.traitementComplet);
      shell.showNext();
    } else if (matchedAny) {
      shell.addMessage("warn", ui.messages.traitementPartiel);
    } else {
      shell.addMessage("warn", ui.messages.traitementNonReconnu);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Step 6 – debriefing                                                */
/* ------------------------------------------------------------------ */

function bestScoreKey() {
  return STORAGE_PREFIX + state.caseData.id;
}

function saveBestScore() {
  try {
    if (state.score > state.bestScore) {
      state.bestScore = state.score;
      localStorage.setItem(bestScoreKey(), String(state.bestScore));
    }
  } catch (error) {
    /* storage unavailable: ignore */
  }
}

function loadBestScore() {
  try {
    const stored = parseInt(localStorage.getItem(bestScoreKey()), 10);
    state.bestScore = Number.isFinite(stored) ? stored : 0;
  } catch (error) {
    state.bestScore = 0;
  }
}

/** One question of the history in the debriefing (asked or missed). */
function buildAnamnesisRow(item, labels, config) {
  const row = el("li", "qa-item " + (item.revealed ? "ok" : "ko") + (item.pertinence === "cle" ? " is-key" : ""));
  const head = el("div", "qa-head");
  head.append(
    el("span", "qa-mark", item.revealed ? "✓" : "✗"),
    el("strong", "qa-label", item.libelle)
  );
  if (item.pertinence === "cle") head.append(el("span", "qa-badge", config.pertinences.cle));
  row.append(head);

  if (item.revealed) {
    row.append(el("div", "qa-question", labels.questionPosee + " : « " + item.question + " »"));
    row.append(el("div", "qa-answer", labels.note + " : " + item.note));
    if (item.pertinence === "cle" && item.pourquoi) {
      row.append(el("div", "qa-why", labels.pourquoi + " : " + item.pourquoi));
    }
  } else {
    if (item.questionExemple) {
      row.append(el("div", "qa-example", labels.questionAPoser + " : « " + item.questionExemple + " »"));
    }
    if (item.pourquoi) row.append(el("div", "qa-why", labels.pourquoi + " : " + item.pourquoi));
  }
  return row;
}

function renderAnamnesisDebrief(card) {
  const session = state.run.anamnesis;
  if (!session) return;
  const config = state.ui.anamnese;
  const labels = config.debrief;
  const items = session.items;

  card.append(el("h2", "section-title", labels.titre), el("p", "qa-intro", labels.intro));

  const keyItems = items.filter((item) => item.pertinence === "cle");
  const keyDone = keyItems.filter((item) => item.revealed).length;
  const totalDone = items.filter((item) => item.revealed).length;
  const summary = el("div", "qa-summary");
  summary.append(
    el("div", "qa-summary-main", formatText(labels.resumeCles, { a: keyDone, b: keyItems.length })),
    el("div", "qa-summary-sub", formatText(labels.resumeTotal, { a: totalDone, b: items.length }))
  );
  const bar = el("div", "qa-bar");
  const fill = el("div", "qa-bar-fill");
  fill.style.width = (keyItems.length ? Math.round((100 * keyDone) / keyItems.length) : 100) + "%";
  bar.append(fill);
  summary.append(bar);
  card.append(summary);
  if (session.questions.length === 0) card.append(el("div", "msg msg-warn", labels.aucuneQuestion));

  config.rubriques.forEach((rubrique) => {
    const inRubric = items.filter((item) => item.rubrique === rubrique.id);
    if (inRubric.length === 0) return;
    const done = inRubric.filter((item) => item.revealed).length;
    const missedKey = inRubric.some((item) => item.pertinence === "cle" && !item.revealed);

    const details = el("details", "qa-rubric");
    if (missedKey) details.setAttribute("open", "");
    const summaryLine = el("summary", "qa-rubric-summary");
    summaryLine.append(
      el("span", "qa-rubric-title", rubrique.titre),
      el("span", "qa-count" + (missedKey ? " has-missing" : ""), done + "/" + inRubric.length)
    );
    details.append(summaryLine);

    const groups = (rubrique.sousRubriques || []).map((sub) => ({ id: sub.id, titre: sub.titre }));
    groups.push({ id: null, titre: null });
    groups.forEach((group) => {
      const rows = inRubric.filter((item) =>
        group.id === null ? !(rubrique.sousRubriques || []).some((sub) => sub.id === item.sousRubrique)
                          : item.sousRubrique === group.id);
      if (rows.length === 0) return;
      if (group.titre) details.append(el("h4", "qa-sub", group.titre));
      const list = el("ul", "qa-list");
      rows.forEach((item) => list.append(buildAnamnesisRow(item, labels, config)));
      details.append(list);
    });
    card.append(details);
  });

  // Communication: feedback only, never scored
  const comm = config.communication;
  card.append(el("h3", "qa-sub qa-comm-title", comm.titre));
  const commList = el("ul", "qa-list");
  ["salutation", "presentation", "empathie", "synthese"].forEach((name) => {
    const feedback = comm.retours[name];
    const done = session.communication[name];
    const row = el("li", "qa-item " + (done ? "ok" : "ko"));
    const head = el("div", "qa-head");
    head.append(el("span", "qa-mark", done ? "✓" : "✗"), el("strong", "qa-label", feedback.libelle));
    row.append(head, el("div", "qa-answer", done ? feedback.ok : feedback.ko));
    commList.append(row);
  });
  card.append(commList);
}

function renderDebrief(step) {
  const ui = state.ui;
  saveBestScore();

  const stage = $("#stage");
  stage.innerHTML = "";
  const card = el("section", "card step-card enter");
  const head = el("div", "step-head");
  head.append(
    el("span", "step-chip", STEP_KEYS.length + "/" + STEP_KEYS.length),
    el("h1", "step-title", step.titre)
  );
  card.append(head);

  const mention = ui.mentions.find((entry) => state.score >= entry.min);
  const final = el("div", "final-score");
  final.append(
    el("div", "label", ui.labelScoreFinal),
    el("div", "big", state.score + "/" + MAX_SCORE),
    el("div", "mention", mention ? mention.texte : "")
  );
  card.append(final);

  // Score breakdown, step by step
  card.append(el("h2", "section-title", ui.libellesDebrief.detailScore));
  if (state.run.events.length === 0) {
    card.append(el("div", "msg msg-good", ui.libellesDebrief.aucunePenalite));
  } else {
    const log = el("ul", "score-log");
    state.run.events.forEach((event) => {
      const row = el("li", "log-row");
      row.append(
        el("span", "log-step", ui.etapesCourtes[event.step] || ""),
        el("span", "log-label", event.label),
        el("span", "log-delta " + (event.delta < 0 ? "minus" : "plus"), (event.delta > 0 ? "+" : "") + event.delta)
      );
      log.append(row);
    });
    card.append(log);
  }

  renderAnamnesisDebrief(card);

  card.append(el("h2", "section-title", ui.libellesDebrief.pointsCles));
  const list = el("ul", "points");
  step.pointsCles.forEach((point, index) => {
    const item = el("li", "point");
    item.style.animationDelay = (index * 0.15) + "s";
    const separator = point.indexOf(":");
    if (separator > 0) {
      item.append(el("strong", null, point.slice(0, separator + 1)), document.createTextNode(point.slice(separator + 1)));
    } else {
      item.textContent = point;
    }
    list.append(item);
  });
  card.append(list);

  const actions = el("div", "actions");
  const replay = el("button", "btn btn-primary", ui.boutonRejouer);
  replay.type = "button";
  replay.addEventListener("click", startCase);
  actions.append(replay);
  card.append(actions);

  stage.append(card);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ------------------------------------------------------------------ */
/* Navigation                                                         */
/* ------------------------------------------------------------------ */

const STEP_RENDERERS = [
  renderAnamnesis,
  renderPhysicalExam,
  renderParaclinical,
  renderDiagnosis,
  renderTreatment,
  renderDebrief
];

function goToStep(index) {
  state.stepIndex = Math.min(index, STEP_KEYS.length - 1);
  renderTracker();
  const step = state.caseData.etapes[STEP_KEYS[state.stepIndex]];
  STEP_RENDERERS[state.stepIndex](step);
}

function startCase() {
  state.score = state.caseData.scoreInitial;
  state.run = createRun();
  $("#topbar").hidden = false;
  renderScore();
  goToStep(0);
}

function renderIntro() {
  const ui = state.ui;
  const data = state.caseData;
  const intro = data.introduction;
  const vitals = getVitals();

  // The top bar (progress, score, monitor) is visible from the very first screen.
  state.score = data.scoreInitial;
  state.stepIndex = -1;
  $("#topbar").hidden = false;
  renderTracker();
  renderScore();
  startMonitor();

  const stage = $("#stage");
  stage.innerHTML = "";
  const card = el("section", "card intro-card enter");
  card.append(
    el("div", "badge", data.specialite),
    el("h1", "intro-title", data.titre),
    el("p", "intro-sub", ui.nomApp + " · " + ui.sousTitre)
  );

  if (data.metadonnees) {
    const chips = el("div", "meta-chips");
    ["difficulte", "dureeEstimee"].forEach((key) => {
      if (data.metadonnees[key]) {
        chips.append(el("span", "meta-chip", ui.libellesMeta[key] + " : " + data.metadonnees[key]));
      }
    });
    card.append(chips);
  }

  const overview = el("div", "overview");
  overview.append(el("h2", null, intro.titre), el("p", "overview-desc", intro.description));

  const grid = el("div", "overview-grid");
  function addRow(label, valueNode) {
    const value = el("div", "overview-value");
    value.append(valueNode);
    grid.append(el("div", "overview-label", label), value);
  }
  addRow(intro.libelles.lieu, document.createTextNode(intro.lieu));
  addRow(intro.libelles.contexte, document.createTextNode(intro.contexte));
  addRow(intro.libelles.motifConsultation, document.createTextNode(intro.motifConsultation));

  const vitalsList = el("div", "overview-vitals");
  Object.keys(vitals).forEach((key) => {
    vitalsList.append(el("div", null, (ui.libellesConstantes[key] || key) + " : " + vitals[key]));
  });
  addRow(intro.libelles.constantes, vitalsList);
  overview.append(grid);
  card.append(overview);

  const start = el("button", "btn btn-primary btn-block", ui.boutonCommencer);
  start.type = "button";
  start.addEventListener("click", startCase);
  card.append(start);

  if (state.bestScore > 0) {
    card.append(el("div", "best", ui.labelMeilleurScore + " : " + state.bestScore + "/" + MAX_SCORE));
  }
  stage.append(card);
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + " : HTTP " + response.status);
  return response.json();
}

async function init() {
  try {
    const [ui, index] = await Promise.all([loadJson(INTERFACE_URL), loadJson(INDEX_URL)]);
    const requestedId = new URLSearchParams(window.location.search).get("cas");
    const entry = index.cas.find((item) => item.id === requestedId) || index.cas[0];
    state.caseData = await loadJson(entry.fichier);
    state.ui = ui;
  } catch (error) {
    const message = state.ui && state.ui.erreurChargement ? state.ui.erreurChargement : LOAD_ERROR_FALLBACK;
    $("#stage").append(el("section", "card error-card", message));
    return;
  }
  loadBestScore();
  document.title = state.ui.nomApp + " – " + state.ui.sousTitre;
  buildTracker();
  buildMonitor();
  renderIntro();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

init();
