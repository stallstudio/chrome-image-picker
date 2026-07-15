// Test de bout en bout de l'extension via Chrome DevTools Protocol.
// Prérequis : Chrome headless lancé avec --remote-debugging-port et
// --enable-unsafe-extension-debugging, serveur HTTP local pour la page de test.

const CDP_PORT = process.env.CDP_PORT ?? "9333";
const EXT_PATH = process.env.EXT_PATH;
const PAGE_URL = process.env.PAGE_URL;
const DL_DIR = process.env.DL_DIR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, label, extra = "") {
  if (cond) {
    console.log("PASS:", label);
  } else {
    console.log("FAIL:", label, extra);
    failures++;
  }
}

const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("connexion WS impossible")); });

let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
    else resolve(msg.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

// --- 1. Charger l'extension --------------------------------------------------
const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT_PATH });
console.log("Extension chargée, id:", extId);

// --- 2. Attendre et attacher le service worker -------------------------------
let swTarget = null;
for (let i = 0; i < 20 && !swTarget; i++) {
  const { targetInfos } = await send("Target.getTargets");
  swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId));
  if (!swTarget) await sleep(250);
}
assert(Boolean(swTarget), "service worker enregistré");
if (!swTarget) process.exit(1);

const { sessionId: swSession } = await send("Target.attachToTarget", {
  targetId: swTarget.targetId,
  flatten: true
});

const swEval = async (expression, awaitPromise = true) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, swSession);
  if (r.exceptionDetails) throw new Error("SW eval: " + JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

// Le script du SW peut être encore en cours d'évaluation : patienter.
let swReady = false;
for (let i = 0; i < 20 && !swReady; i++) {
  try {
    swReady = (await swEval("typeof DEFAULTS", false)) === "object";
  } catch {
    // session pas encore prête
  }
  if (!swReady) await sleep(250);
}
assert(swReady && (await swEval("DEFAULTS.shortcutCode", false)) === "AltLeft", "common.js chargé dans le SW");

// Précondition : navigateur vierge (sinon on parle à un zombie d'un run passé).
const preexisting = await swEval("chrome.downloads.search({})");
if (preexisting.length > 0) {
  console.error("ABANDON : historique de téléchargements non vide — instance Chrome parasite ?", preexisting.length);
  process.exit(2);
}

// Note : les téléchargements sont confinés via les Preferences du profil
// (download.default_directory) — Browser.setDownloadBehavior court-circuiterait
// le pipeline de nommage (onDeterminingFilename, uniquify).

// --- 3. Ouvrir la page de test ------------------------------------------------
const { targetId: pageTargetId } = await send("Target.createTarget", { url: PAGE_URL });
const { sessionId: pageSession } = await send("Target.attachToTarget", {
  targetId: pageTargetId,
  flatten: true
});
await sleep(1500); // content script injecté à document_idle

const pageEval = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true }, pageSession);
  if (r.exceptionDetails) throw new Error("page eval: " + JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const mouse = (type, x, y, opts = {}) =>
  send("Input.dispatchMouseEvent", { type, x, y, ...opts }, pageSession);
const click = async (x, y) => {
  await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
  await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
};
const isActive = () => pageEval('document.documentElement.classList.contains("cip-active")');
const overlayDisplay = () =>
  pageEval('(() => { const o = document.getElementById("cip-overlay"); return o ? getComputedStyle(o).display : "absent"; })()');

// --- 4. Inactif par défaut -----------------------------------------------------
assert((await isActive()) === false, "inactif par défaut");

// --- 5. Activation persistante via storage (propagation live) ------------------
await swEval("chrome.storage.sync.set({enabled: true})");
await sleep(400);
assert((await isActive()) === true, "activation via storage propagée au content script");

// --- 6. Survol de l'image -> overlay -------------------------------------------
await mouse("mouseMoved", 50, 25);
await sleep(200);
const overlayWidth = await pageEval(
  '(() => { const o = document.getElementById("cip-overlay"); return o && getComputedStyle(o).display === "block" ? o.getBoundingClientRect().width : null; })()'
);
assert(overlayWidth === 100, "overlay affiché sur <img> (largeur 100)", String(overlayWidth));

// --- 7. Clic -> meilleure résolution téléchargée, pas de navigation -------------
await click(50, 25);
let items = [];
for (let i = 0; i < 20; i++) {
  items = await swEval("chrome.downloads.search({})");
  if (items.length >= 1 && items.every((d) => d.state === "complete")) break;
  await sleep(250);
}
assert(
  items.length === 1 && items[0].url.endsWith("/big.png"),
  "clic télécharge la meilleure résolution du srcset (big.png)",
  JSON.stringify(items.map((d) => [d.id, d.startTime, d.url, d.state, d.filename])) +
    " | messages reçus par le SW : " +
    (await swEval("JSON.stringify([...pendingByUrl.keys()])", false))
);
assert((await pageEval("location.pathname")) === "/test.html", "clic sur image dans un lien : pas de navigation");

// --- 8. Fond CSS : ignoré par défaut, détecté une fois l'option activée ---------
await mouse("mouseMoved", 60, 140);
await sleep(200);
assert((await overlayDisplay()) === "none", "fond CSS ignoré quand l'option est désactivée");

await swEval("chrome.storage.sync.set({detectBackgrounds: true})");
await sleep(400);
await mouse("mouseMoved", 61, 140);
await sleep(200);
assert((await overlayDisplay()) === "block", "fond CSS détecté après activation de l'option (sans recharger)");

await click(61, 140);
for (let i = 0; i < 20; i++) {
  items = await swEval("chrome.downloads.search({})");
  if (items.length >= 2 && items.every((d) => d.state === "complete")) break;
  await sleep(250);
}
assert(
  items.some((d) => d.url.endsWith("/bg.png")),
  "clic télécharge l'image de fond CSS",
  JSON.stringify(items.map((d) => d.url))
);

// --- 8bis. SVG inline et canvas : ignorés par défaut, détectés avec l'option ------
await mouse("mouseMoved", 360, 65); // centre du <svg id="vec">
await sleep(200);
assert((await overlayDisplay()) === "none", "SVG inline ignoré quand l'option est désactivée");

await swEval("chrome.storage.sync.set({detectExtras: true})");
await sleep(400);
await mouse("mouseMoved", 361, 65);
await sleep(200);
assert((await overlayDisplay()) === "block", "SVG inline détecté après activation de l'option");
await click(361, 65);
for (let i = 0; i < 20; i++) {
  items = await swEval("chrome.downloads.search({})");
  if (items.length >= 3 && items.every((d) => d.state === "complete")) break;
  await sleep(250);
}
assert(
  items.some((d) => d.url.startsWith("data:image/svg") && d.filename.endsWith(".svg")),
  "clic télécharge le SVG sérialisé (.svg)",
  JSON.stringify(items.map((d) => [d.url.slice(0, 40), d.filename]))
);

await mouse("mouseMoved", 350, 190); // centre du <canvas id="cv">
await sleep(200);
assert((await overlayDisplay()) === "block", "canvas détecté");
await click(350, 190);
for (let i = 0; i < 20; i++) {
  items = await swEval("chrome.downloads.search({})");
  if (items.length >= 4 && items.every((d) => d.state === "complete")) break;
  await sleep(250);
}
assert(
  items.some((d) => d.url.startsWith("data:image/png") && d.filename.endsWith(".png") && d.filename.includes("image-")),
  "clic télécharge le canvas (.png)",
  JSON.stringify(items.map((d) => [d.url.slice(0, 40), d.filename]))
);
await swEval("chrome.storage.sync.set({detectExtras: false})");

// --- 8ter. Sous-dossier + modèle de nom de fichier -------------------------------
await swEval('chrome.storage.sync.set({subfolder: "Image Picker", filenameTemplate: "{domain}-{name}"})');
await sleep(400);
await mouse("mouseMoved", 50, 25);
await sleep(200);
await click(50, 25);
for (let i = 0; i < 20; i++) {
  items = await swEval("chrome.downloads.search({})");
  if (items.length >= 5 && items.every((d) => d.state === "complete")) break;
  await sleep(250);
}
const custom = items.find((d) => d.filename.includes("Image Picker/"));
assert(
  Boolean(custom) && /Image Picker\/127\.0\.0\.1-big\.png$/.test(custom.filename),
  "sous-dossier + modèle appliqués (Image Picker/127.0.0.1-big.png)",
  JSON.stringify(items.map((d) => d.filename))
);
await swEval('chrome.storage.sync.set({subfolder: "", filenameTemplate: "{nom}"})');

// --- 9. Désactivation persistante ------------------------------------------------
await swEval("chrome.storage.sync.set({enabled: false, detectBackgrounds: false})");
await sleep(400);
assert((await isActive()) === false, "désactivation via storage propagée");

// --- 10. Touche maintenue / relâchée ----------------------------------------------
const key = (type) =>
  send(
    "Input.dispatchKeyEvent",
    { type, code: "AltLeft", key: "Alt", windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 },
    pageSession
  );
await key("rawKeyDown");
await sleep(200);
assert((await isActive()) === true, "touche maintenue -> mode actif");
await key("keyUp");
await sleep(200);
assert((await isActive()) === false, "touche relâchée -> mode inactif");

ws.close();
console.log(failures === 0 ? "== TOUS LES TESTS PASSENT ==" : `== ${failures} ÉCHEC(S) ==`);
process.exit(failures === 0 ? 0 : 1);
