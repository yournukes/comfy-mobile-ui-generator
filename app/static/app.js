const baseUrlInput = document.getElementById("baseUrl");
const loadObjectInfoButton = document.getElementById("loadObjectInfo");
const saveDefaultUrlButton = document.getElementById("saveDefaultUrl");
const restoreDefaultUrlButton = document.getElementById("restoreDefaultUrl");
const baseUrlStatus = document.getElementById("baseUrlStatus");

const promptInput = document.getElementById("promptInput");
const parsePromptButton = document.getElementById("parsePrompt");
const queuePromptButton = document.getElementById("queuePrompt");
const repeatToggleButton = document.getElementById("repeatToggle");
const parseStatus = document.getElementById("parseStatus");
const repeatStatus = document.getElementById("repeatStatus");
const promptFileInput = document.getElementById("promptFile");

const clearLogButton = document.getElementById("clearLog");
const logList = document.getElementById("logList");

const promptTitleInput = document.getElementById("promptTitle");
const savePromptButton = document.getElementById("savePrompt");
const refreshSavedButton = document.getElementById("refreshSaved");
const saveStatus = document.getElementById("saveStatus");
const savedList = document.getElementById("savedList");

const nodeCards = document.getElementById("nodeCards");

const executionState = document.getElementById("executionState");
const currentNode = document.getElementById("currentNode");
const progressBarFill = document.getElementById("progressBarFill");
const progressText = document.getElementById("progressText");
const executionError = document.getElementById("executionError");

const resultImages = document.getElementById("resultImages");
let isMaskedDefault = true;

let objectInfo = {};
let currentPrompt = null;
let currentPromptWrapper = null;
let wsConnection = null;
let activeRun = { mode: null, promptId: null, baseUrl: null };
let lastRepeatPromptId = null;
let wsMode = null;
let activeWsClientId = null;
let activeWsBaseUrl = null;
let repeatActive = false;

function formatTimestamp(date = new Date()) {
  return date.toLocaleTimeString("ja-JP", { hour12: false });
}

function addLogEntry(title, payload, isError = false) {
  const entry = document.createElement("div");
  entry.className = "log-entry";

  const header = document.createElement("div");
  header.className = "log-entry-header";
  header.textContent = `[${formatTimestamp()}] ${title}`;
  if (isError) {
    header.classList.add("error");
  }

  const body = document.createElement("pre");
  body.className = "log-entry-body";
  body.textContent = typeof payload === "string" ? payload : safeStringify(payload);

  entry.appendChild(header);
  entry.appendChild(body);
  logList.prepend(entry);
}

function clearLogs() {
  logList.innerHTML = "";
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const data = await response.json();
      detail = data.detail || detail;
    } catch (error) {
      // ignore
    }
    throw new Error(detail);
  }
  return response.json();
}

function safeStringify(value) {
  return JSON.stringify(value, null, 2);
}

function handlePromptFileUpload(event) {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  if (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json") {
    setStatus(parseStatus, "JSON ファイルを選択してください", true);
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    promptInput.value = text;
    const parsed = parsePromptJson();
    if (parsed) {
      const output = currentPromptWrapper
        ? { ...currentPromptWrapper, prompt: currentPrompt }
        : currentPrompt;
      promptInput.value = safeStringify(output);
      setStatus(parseStatus, `ファイルを読み込みました: ${file.name}`);
    }
  };
  reader.onerror = () => {
    setStatus(parseStatus, "ファイルの読み込みに失敗しました", true);
  };
  reader.readAsText(file);
}

function parsePromptJson() {
  const text = promptInput.value.trim();
  if (!text) {
    setStatus(parseStatus, "JSON を入力してください", true);
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.prompt) {
      currentPromptWrapper = parsed;
      currentPrompt = parsed.prompt;
    } else {
      currentPromptWrapper = null;
      currentPrompt = parsed;
    }
    setStatus(parseStatus, "解析に成功しました");
    renderNodeCards();
    return currentPrompt;
  } catch (error) {
    setStatus(parseStatus, `JSON エラー: ${error.message}`, true);
    addLogEntry("JSON 解析エラー", error.message, true);
    return null;
  }
}

function syncPromptTextarea() {
  if (!currentPrompt) {
    return;
  }
  const output = currentPromptWrapper
    ? { ...currentPromptWrapper, prompt: currentPrompt }
    : currentPrompt;
  promptInput.value = safeStringify(output);
}

function getInputSpec(classType, key) {
  const info = objectInfo[classType];
  if (!info || !info.input) {
    return null;
  }
  return (
    (info.input.required && info.input.required[key]) ||
    (info.input.optional && info.input.optional[key]) ||
    null
  );
}

function resolveReference(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const [nodeId, outputIndex] = value;
  if (!currentPrompt || !currentPrompt[nodeId]) {
    return { nodeId, outputIndex, classType: "?" };
  }
  return { nodeId, outputIndex, classType: currentPrompt[nodeId].class_type };
}

function createInputControl(nodeId, key, value, spec) {
  const wrapper = document.createElement("div");
  wrapper.className = "input-row";

  const label = document.createElement("label");
  label.textContent = key;
  label.className = "input-label";
  wrapper.appendChild(label);

  const inputContainer = document.createElement("div");
  inputContainer.className = "input-control";

  let inputElement = null;
  const resolvedRef = resolveReference(value);
  if (resolvedRef) {
    inputElement = document.createElement("input");
    inputElement.type = "text";
    inputElement.value = safeStringify(value);
    inputElement.addEventListener("change", () => {
      try {
        const parsed = JSON.parse(inputElement.value);
        currentPrompt[nodeId].inputs[key] = parsed;
        syncPromptTextarea();
      } catch (error) {
        setStatus(parseStatus, `入力エラー: ${error.message}`, true);
      }
    });

    const reference = document.createElement("div");
    reference.className = "input-reference";
    reference.textContent = `参照: ${resolvedRef.nodeId} (${resolvedRef.classType}) 出力 ${resolvedRef.outputIndex}`;
    inputContainer.appendChild(reference);
  } else if (spec && Array.isArray(spec)) {
    const type = spec[0];
    const options = spec[1] || {};
    const choices = options.choices || options.values || null;
    if (choices) {
      inputElement = document.createElement("select");
      choices.forEach((choice) => {
        const opt = document.createElement("option");
        opt.value = choice;
        opt.textContent = choice;
        if (choice === value) {
          opt.selected = true;
        }
        inputElement.appendChild(opt);
      });
      inputElement.addEventListener("change", () => {
        currentPrompt[nodeId].inputs[key] = inputElement.value;
        syncPromptTextarea();
      });
    } else if (type === "BOOLEAN" || type === "BOOL" || typeof value === "boolean") {
      inputElement = document.createElement("input");
      inputElement.type = "checkbox";
      inputElement.checked = Boolean(value);
      inputElement.addEventListener("change", () => {
        currentPrompt[nodeId].inputs[key] = inputElement.checked;
        syncPromptTextarea();
      });
    } else if (type === "STRING" && (options.multiline || options.rows)) {
      inputElement = document.createElement("textarea");
      inputElement.rows = options.rows || 3;
      inputElement.value = value ?? options.default ?? "";
      inputElement.addEventListener("input", () => {
        currentPrompt[nodeId].inputs[key] = inputElement.value;
        syncPromptTextarea();
      });
    } else if (type === "INT" || type === "FLOAT" || typeof value === "number") {
      inputElement = document.createElement("input");
      inputElement.type = "number";
      if (options.min !== undefined) inputElement.min = options.min;
      if (options.max !== undefined) inputElement.max = options.max;
      if (options.step !== undefined) inputElement.step = options.step;
      inputElement.value = value;
      inputElement.addEventListener("change", () => {
        const parsed = type === "INT" ? parseInt(inputElement.value, 10) : parseFloat(inputElement.value);
        currentPrompt[nodeId].inputs[key] = Number.isNaN(parsed) ? value : parsed;
        syncPromptTextarea();
      });
    } else {
      inputElement = document.createElement("input");
      inputElement.type = "text";
      inputElement.value = value ?? "";
      inputElement.addEventListener("change", () => {
        currentPrompt[nodeId].inputs[key] = inputElement.value;
        syncPromptTextarea();
      });
    }
  } else {
    inputElement = document.createElement("input");
    inputElement.type = "text";
    inputElement.value = value ?? "";
    inputElement.addEventListener("change", () => {
      currentPrompt[nodeId].inputs[key] = inputElement.value;
      syncPromptTextarea();
    });
  }

  inputContainer.appendChild(inputElement);
  wrapper.appendChild(inputContainer);
  return wrapper;
}

function renderNodeCards() {
  nodeCards.innerHTML = "";
  resultImages.innerHTML = "";
  if (!currentPrompt || typeof currentPrompt !== "object") {
    return;
  }
  Object.entries(currentPrompt).forEach(([nodeId, nodeData]) => {
    const card = document.createElement("div");
    card.className = "node-card";

    const header = document.createElement("button");
    header.className = "node-header";
    header.type = "button";
    header.textContent = `${nodeId} - ${nodeData.class_type}`;
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "node-body";

    const inputs = nodeData.inputs || {};
    Object.entries(inputs).forEach(([key, value]) => {
      const spec = getInputSpec(nodeData.class_type, key);
      const row = createInputControl(nodeId, key, value, spec);
      body.appendChild(row);
    });

    if (!Object.keys(inputs).length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "inputs がありません";
      body.appendChild(empty);
    }

    header.addEventListener("click", () => {
      body.classList.toggle("collapsed");
    });

    card.appendChild(body);
    nodeCards.appendChild(card);
  });
}

async function loadObjectInfo() {
  const baseUrl = baseUrlInput.value.trim();
  if (!baseUrl) {
    setStatus(baseUrlStatus, "ComfyUI URL を入力してください", true);
    return;
  }
  setStatus(baseUrlStatus, "取得中...");
  try {
    objectInfo = await fetchJson(`/api/object_info?base_url=${encodeURIComponent(baseUrl)}`);
    setStatus(baseUrlStatus, "ノード定義を取得しました");
    addLogEntry("ノード定義取得レスポンス", objectInfo);
    renderNodeCards();
  } catch (error) {
    setStatus(baseUrlStatus, `取得失敗: ${error.message}`, true);
    addLogEntry("ノード定義取得失敗", error.message, true);
  }
}

async function saveDefaultUrl() {
  try {
    await fetchJson("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_comfy_base_url: baseUrlInput.value.trim() }),
    });
    setStatus(baseUrlStatus, "デフォルトURLを保存しました");
  } catch (error) {
    setStatus(baseUrlStatus, `保存失敗: ${error.message}`, true);
  }
}

async function restoreDefaultUrl() {
  try {
    const settings = await fetchJson("/api/settings");
    baseUrlInput.value = settings.default_comfy_base_url || "";
    setStatus(baseUrlStatus, "デフォルトURLを復元しました");
  } catch (error) {
    setStatus(baseUrlStatus, `復元失敗: ${error.message}`, true);
  }
}

async function queuePrompt() {
  const baseUrl = baseUrlInput.value.trim();
  if (!baseUrl) {
    setStatus(parseStatus, "ComfyUI URL を入力してください", true);
    return;
  }
  if (!currentPrompt) {
    parsePromptJson();
  }
  if (!currentPrompt) {
    return;
  }
  setStatus(parseStatus, "キュー投入中...");
  resetExecutionState();
  try {
    const response = await fetchJson("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: baseUrl, prompt: currentPrompt }),
    });
    activeRun = { mode: "manual", promptId: response.prompt_id, baseUrl };
    setStatus(parseStatus, `キュー投入完了: ${response.prompt_id}`);
    addLogEntry("キュー投入レスポンス", response);
    connectWebSocket(baseUrl, response.client_id);
  } catch (error) {
    setStatus(parseStatus, `キュー投入失敗: ${error.message}`, true);
    addLogEntry("キュー投入失敗", error.message, true);
  }
}

function renderRepeatStatus(state) {
  repeatActive = Boolean(state.active);
  repeatToggleButton.textContent = repeatActive ? "連続実行停止" : "連続実行開始";
  repeatToggleButton.classList.toggle("repeat-active", repeatActive);
  let message = repeatActive ? "連続実行中" : "停止中";
  if (state.runs !== undefined && state.runs !== null) {
    message += ` / 実行回数: ${state.runs}`;
  }
  if (state.last_prompt_id) {
    message += ` / 最新ID: ${state.last_prompt_id}`;
  }
  if (state.last_finished_at) {
    message += ` / 最終完了: ${state.last_finished_at}`;
  }
  if (state.last_error) {
    setStatus(repeatStatus, `連続実行エラー: ${state.last_error}`, true);
  } else {
    setStatus(repeatStatus, message);
  }
}

async function refreshRepeatStatus() {
  try {
    const data = await fetchJson("/api/repeat/status");
    renderRepeatStatus(data);
    if (data.active && data.client_id) {
      const baseUrl = data.base_url || baseUrlInput.value.trim();
      if (baseUrl && wsMode !== "manual") {
        connectRepeatWebSocket(baseUrl, data.client_id);
      }
    } else if (!data.active && wsMode === "repeat") {
      wsConnection?.close();
      wsMode = null;
      activeWsClientId = null;
      activeWsBaseUrl = null;
    }
    if (data.last_prompt_id) {
      const baseUrl = data.base_url || baseUrlInput.value.trim();
      if (data.last_prompt_id !== lastRepeatPromptId) {
        lastRepeatPromptId = data.last_prompt_id;
      }
      if (data.active && activeRun.mode !== "manual" && activeRun.promptId !== data.last_prompt_id) {
        activeRun = { mode: "repeat", promptId: data.last_prompt_id, baseUrl };
        resetExecutionState();
      }
    } else if (!data.active && activeRun.mode === "repeat") {
      activeRun = { mode: null, promptId: null, baseUrl: activeRun.baseUrl };
    }
  } catch (error) {
    setStatus(repeatStatus, `連続実行ステータス取得失敗: ${error.message}`, true);
  }
}

async function toggleRepeat() {
  if (repeatActive) {
    try {
      const data = await fetchJson("/api/repeat/stop", { method: "POST" });
      renderRepeatStatus(data);
      if (wsMode === "repeat") {
        wsConnection?.close();
        wsMode = null;
        activeWsClientId = null;
        activeWsBaseUrl = null;
      }
      if (activeRun.mode === "repeat") {
        activeRun = { mode: null, promptId: null, baseUrl: activeRun.baseUrl };
      }
      setStatus(repeatStatus, "連続実行を停止しました");
    } catch (error) {
      setStatus(repeatStatus, `停止失敗: ${error.message}`, true);
    }
    return;
  }
  const baseUrl = baseUrlInput.value.trim();
  if (!baseUrl) {
    setStatus(repeatStatus, "ComfyUI URL を入力してください", true);
    return;
  }
  if (!currentPrompt) {
    parsePromptJson();
  }
  if (!currentPrompt) {
    return;
  }
  setStatus(repeatStatus, "連続実行を開始しています...");
  try {
    const data = await fetchJson("/api/repeat/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: baseUrl, prompt: currentPrompt }),
    });
    renderRepeatStatus(data);
    activeRun = { mode: "repeat", promptId: data.last_prompt_id || null, baseUrl };
    if (data.client_id) {
      connectRepeatWebSocket(baseUrl, data.client_id);
    }
  } catch (error) {
    setStatus(repeatStatus, `連続実行開始失敗: ${error.message}`, true);
  }
}

function resetExecutionState() {
  executionState.textContent = "待機中";
  currentNode.textContent = "-";
  progressBarFill.style.width = "0%";
  progressText.textContent = "0%";
  executionError.textContent = "";
  resultImages.innerHTML = "";
}

function connectWebSocket(baseUrl, clientId) {
  if (wsConnection) {
    wsConnection.close();
  }
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?base_url=${encodeURIComponent(baseUrl)}&client_id=${encodeURIComponent(clientId)}`;
  wsConnection = new WebSocket(wsUrl);
  wsMode = "manual";
  activeWsClientId = clientId;
  activeWsBaseUrl = baseUrl;
  wsConnection.onopen = () => {
    executionState.textContent = "接続済み";
  };
  wsConnection.onclose = () => {
    executionState.textContent = "WS切断";
  };
  wsConnection.onerror = () => {
    executionState.textContent = "WSエラー";
  };
  wsConnection.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    } catch (error) {
      console.warn("WS parse error", error);
    }
  };
}

function connectRepeatWebSocket(baseUrl, clientId) {
  if (wsMode === "repeat" && activeWsClientId === clientId && activeWsBaseUrl === baseUrl && wsConnection) {
    return;
  }
  if (wsConnection) {
    wsConnection.close();
  }
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?base_url=${encodeURIComponent(baseUrl)}&client_id=${encodeURIComponent(clientId)}`;
  wsConnection = new WebSocket(wsUrl);
  wsMode = "repeat";
  activeWsClientId = clientId;
  activeWsBaseUrl = baseUrl;
  wsConnection.onopen = () => {
    executionState.textContent = "連続実行WS接続";
  };
  wsConnection.onclose = () => {
    executionState.textContent = "WS切断";
  };
  wsConnection.onerror = () => {
    executionState.textContent = "WSエラー";
  };
  wsConnection.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    } catch (error) {
      console.warn("WS parse error", error);
    }
  };
}

function handleWsEvent(data) {
  if (!data || !data.type) {
    return;
  }
  const payload = data.data ?? data;
  const matchesLatestPrompt = () => {
    if (!activeRun.promptId) {
      return true;
    }
    return !payload.prompt_id || payload.prompt_id === activeRun.promptId;
  };
  switch (data.type) {
    case "execution_start":
      if (!matchesLatestPrompt()) {
        return;
      }
      executionState.textContent = "実行開始";
      break;
    case "executing":
      if (!matchesLatestPrompt()) {
        return;
      }
      if (payload.node === null) {
        executionState.textContent = "完了";
        currentNode.textContent = "-";
        fetchResults();
        if (activeRun.mode === "manual") {
          activeRun = { mode: null, promptId: null, baseUrl: activeRun.baseUrl };
        }
      } else if (payload.node === undefined) {
        executionState.textContent = "実行中";
        currentNode.textContent = "-";
      } else {
        executionState.textContent = "実行中";
        const nodeData = currentPrompt && currentPrompt[payload.node];
        const classType = nodeData ? nodeData.class_type : "?";
        currentNode.textContent = `${payload.node} (${classType})`;
      }
      break;
    case "progress":
      if (!matchesLatestPrompt()) {
        return;
      }
      if (payload.value !== undefined && payload.max) {
        const percent = Math.min(100, Math.round((payload.value / payload.max) * 100));
        progressBarFill.style.width = `${percent}%`;
        progressText.textContent = `${percent}%`;
      }
      break;
    case "execution_success":
      if (!matchesLatestPrompt()) {
        return;
      }
      executionState.textContent = "成功";
      fetchResults();
      if (activeRun.mode === "manual") {
        activeRun = { mode: null, promptId: null, baseUrl: activeRun.baseUrl };
      }
      break;
    case "execution_error":
    case "execution_interrupted":
      if (!matchesLatestPrompt()) {
        return;
      }
      executionState.textContent = "エラー";
      executionError.textContent = payload.message || data.message || "エラーが発生しました";
      if (activeRun.mode === "manual") {
        activeRun = { mode: null, promptId: null, baseUrl: activeRun.baseUrl };
      }
      break;
    case "executed":
      if (!matchesLatestPrompt()) {
        return;
      }
      executionState.textContent = "ノード完了";
      break;
    case "proxy_error":
      executionState.textContent = "WSエラー";
      executionError.textContent = data.message;
      break;
    default:
      break;
  }
}

async function fetchResults() {
  if (!activeRun.promptId) {
    return;
  }
  const baseUrl = activeRun.baseUrl || baseUrlInput.value.trim();
  try {
    const history = await fetchJson(`/api/history?base_url=${encodeURIComponent(baseUrl)}&prompt_id=${encodeURIComponent(activeRun.promptId)}`);
    addLogEntry("履歴取得レスポンス", history);
    const images = extractImages(history);
    renderImages(images, baseUrl);
  } catch (error) {
    executionError.textContent = `結果取得失敗: ${error.message}`;
    addLogEntry("履歴取得失敗", error.message, true);
  }
}

function extractImages(history) {
  const items = [];
  if (!history || typeof history !== "object") {
    return items;
  }
  const entry = history[activeRun.promptId];
  if (!entry || !entry.outputs) {
    return items;
  }
  Object.values(entry.outputs).forEach((output) => {
    if (output.images) {
      output.images.forEach((image) => items.push(image));
    }
  });
  return items;
}

function renderImages(images, baseUrl) {
  resultImages.innerHTML = "";
  if (!images.length) {
    resultImages.textContent = "画像が見つかりませんでした";
    return;
  }
  isMaskedDefault = true;
  const controls = document.createElement("div");
  controls.className = "image-controls";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "secondary";
  const updateToggleLabel = () => {
    toggleButton.textContent = isMaskedDefault ? "マスク解除" : "マスク表示";
  };
  updateToggleLabel();
  toggleButton.addEventListener("click", () => {
    isMaskedDefault = !isMaskedDefault;
    resultImages.classList.toggle("masked", isMaskedDefault);
    updateToggleLabel();
  });

  controls.appendChild(toggleButton);
  resultImages.appendChild(controls);

  const grid = document.createElement("div");
  grid.className = "image-grid";
  resultImages.appendChild(grid);

  resultImages.classList.toggle("masked", isMaskedDefault);
  images.forEach((image) => {
    const url = `/api/view?base_url=${encodeURIComponent(baseUrl)}&filename=${encodeURIComponent(image.filename)}${image.subfolder ? `&subfolder=${encodeURIComponent(image.subfolder)}` : ""}${image.type ? `&type=${encodeURIComponent(image.type)}` : ""}`;
    const img = document.createElement("img");
    img.src = url;
    img.alt = image.filename;
    img.loading = "lazy";
    img.addEventListener("click", () => {
      img.classList.toggle("zoom");
    });
    grid.appendChild(img);
  });
}

async function refreshSavedList() {
  try {
    const data = await fetchJson("/api/prompts");
    renderSavedList(data.items || []);
  } catch (error) {
    setStatus(saveStatus, `一覧取得失敗: ${error.message}`, true);
  }
}

function renderSavedList(items) {
  savedList.innerHTML = "";
  if (!items.length) {
    savedList.textContent = "保存済みデータがありません";
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "saved-item";

    const title = document.createElement("div");
    title.className = "saved-title";
    title.textContent = `${item.title} (${item.id})`;

    const meta = document.createElement("div");
    meta.className = "saved-meta";
    meta.textContent = `更新: ${item.updated_at || "-"}`;

    const actions = document.createElement("div");
    actions.className = "saved-actions";

    const loadButton = document.createElement("button");
    loadButton.textContent = "読み込み";
    loadButton.addEventListener("click", async () => {
      try {
        const data = await fetchJson(`/api/prompts/${encodeURIComponent(item.id)}`);
        promptInput.value = safeStringify(data.prompt_json);
        promptTitleInput.value = data.title || "";
        parsePromptJson();
        setStatus(saveStatus, "読み込みました");
      } catch (error) {
        setStatus(saveStatus, `読み込み失敗: ${error.message}`, true);
      }
    });

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "削除";
    deleteButton.className = "danger";
    deleteButton.addEventListener("click", async () => {
      if (!confirm("削除しますか？")) {
        return;
      }
      try {
        await fetchJson(`/api/prompts/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        setStatus(saveStatus, "削除しました");
        refreshSavedList();
      } catch (error) {
        setStatus(saveStatus, `削除失敗: ${error.message}`, true);
      }
    });

    actions.appendChild(loadButton);
    actions.appendChild(deleteButton);

    row.appendChild(title);
    row.appendChild(meta);
    row.appendChild(actions);
    savedList.appendChild(row);
  });
}

async function savePrompt() {
  const title = promptTitleInput.value.trim();
  if (!title) {
    setStatus(saveStatus, "タイトルを入力してください", true);
    return;
  }
  if (!currentPrompt) {
    parsePromptJson();
  }
  if (!currentPrompt) {
    return;
  }
  try {
    await fetchJson("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, prompt_json: currentPrompt }),
    });
    setStatus(saveStatus, "保存しました");
    refreshSavedList();
  } catch (error) {
    setStatus(saveStatus, `保存失敗: ${error.message}`, true);
  }
}

parsePromptButton.addEventListener("click", parsePromptJson);
queuePromptButton.addEventListener("click", queuePrompt);
repeatToggleButton.addEventListener("click", toggleRepeat);
loadObjectInfoButton.addEventListener("click", loadObjectInfo);
saveDefaultUrlButton.addEventListener("click", saveDefaultUrl);
restoreDefaultUrlButton.addEventListener("click", restoreDefaultUrl);
savePromptButton.addEventListener("click", savePrompt);
refreshSavedButton.addEventListener("click", refreshSavedList);
clearLogButton.addEventListener("click", clearLogs);
promptFileInput.addEventListener("change", handlePromptFileUpload);
promptInput.addEventListener("input", () => {
  promptInput.style.height = "";
});

refreshSavedList();
refreshRepeatStatus();
setInterval(refreshRepeatStatus, 5000);
