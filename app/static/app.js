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

let objectInfo = {};
let currentPrompt = null;
let currentPromptWrapper = null;
let wsConnection = null;
let latestPromptId = null;
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

function resizePromptTextarea() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${promptInput.scrollHeight}px`;
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
    resizePromptTextarea();
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
  resizePromptTextarea();
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
    latestPromptId = response.prompt_id;
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
  } catch (error) {
    setStatus(repeatStatus, `連続実行ステータス取得失敗: ${error.message}`, true);
  }
}

async function toggleRepeat() {
  if (repeatActive) {
    try {
      const data = await fetchJson("/api/repeat/stop", { method: "POST" });
      renderRepeatStatus(data);
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

function handleWsEvent(data) {
  if (!data || !data.type) {
    return;
  }
  switch (data.type) {
    case "execution_start":
      executionState.textContent = "実行開始";
      break;
    case "executing":
      if (data.node === null) {
        executionState.textContent = "完了";
        fetchResults();
      } else {
        executionState.textContent = "実行中";
        const nodeData = currentPrompt && currentPrompt[data.node];
        const classType = nodeData ? nodeData.class_type : "?";
        currentNode.textContent = `${data.node} (${classType})`;
      }
      break;
    case "progress":
      if (data.value !== undefined && data.max) {
        const percent = Math.min(100, Math.round((data.value / data.max) * 100));
        progressBarFill.style.width = `${percent}%`;
        progressText.textContent = `${percent}%`;
      }
      break;
    case "execution_success":
      executionState.textContent = "成功";
      fetchResults();
      break;
    case "execution_error":
    case "execution_interrupted":
      executionState.textContent = "エラー";
      executionError.textContent = data.message || "エラーが発生しました";
      break;
    case "executed":
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
  if (!latestPromptId) {
    return;
  }
  const baseUrl = baseUrlInput.value.trim();
  try {
    const history = await fetchJson(`/api/history?base_url=${encodeURIComponent(baseUrl)}&prompt_id=${encodeURIComponent(latestPromptId)}`);
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
  const entry = history[latestPromptId];
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
  images.forEach((image) => {
    const url = `/api/view?base_url=${encodeURIComponent(baseUrl)}&filename=${encodeURIComponent(image.filename)}${image.subfolder ? `&subfolder=${encodeURIComponent(image.subfolder)}` : ""}${image.type ? `&type=${encodeURIComponent(image.type)}` : ""}`;
    const img = document.createElement("img");
    img.src = url;
    img.alt = image.filename;
    img.loading = "lazy";
    img.addEventListener("click", () => {
      img.classList.toggle("zoom");
    });
    resultImages.appendChild(img);
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
promptInput.addEventListener("input", resizePromptTextarea);

refreshSavedList();
refreshRepeatStatus();
setInterval(refreshRepeatStatus, 5000);
resizePromptTextarea();
