// Service worker : téléchargements, badge « ON » et relais de l'état de la
// touche maintenue entre les frames d'un même onglet.

importScripts("common.js");

const BADGE_COLOR = "#1a7f37";

// --- Badge -----------------------------------------------------------------

function refreshBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

async function refreshBadgeFromStorage() {
  const { enabled } = await chrome.storage.sync.get(DEFAULTS);
  refreshBadge(enabled);
}

chrome.runtime.onInstalled.addListener(refreshBadgeFromStorage);
chrome.runtime.onStartup.addListener(refreshBadgeFromStorage);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.enabled) refreshBadge(changes.enabled.newValue);
});

// --- Téléchargements et nom de fichier ----------------------------------------

// Métadonnées des téléchargements initiés par l'extension, indexées par URL.
// Renseignées AVANT downloads.download pour éviter toute course avec
// onDeterminingFilename. TTL de sécurité si le téléchargement n'aboutit pas.
const pendingByUrl = new Map();

// Extension de fichier depuis le type MIME d'une URL data:.
function filenameForDataUrl(url) {
  const m = /^data:image\/([a-z0-9+.-]+)/i.exec(url);
  const ext = m ? m[1].replace("jpeg", "jpg").split("+")[0] : "png";
  return `image-${Date.now()}.${ext}`;
}

function splitExt(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1).replace(/[^a-z0-9]/gi, "") };
}

async function startDownload(msg, sender) {
  const { subfolder, filenameTemplate } = await chrome.storage.sync.get(DEFAULTS);
  let hostname = "";
  try {
    hostname = new URL(sender.url || sender.tab?.url || "").hostname;
  } catch {
    // URL de la frame émettrice indisponible : jeton {domaine} vide.
  }
  const providedFilename =
    msg.filename || (msg.url.startsWith("data:") ? filenameForDataUrl(msg.url) : null);
  pendingByUrl.set(msg.url, { hostname, providedFilename, subfolder, filenameTemplate });
  setTimeout(() => pendingByUrl.delete(msg.url), 60_000);

  return new Promise((resolve) => {
    chrome.downloads.download({ url: msg.url, conflictAction: "uniquify" }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        pendingByUrl.delete(msg.url);
        resolve({
          ok: false,
          error: chrome.runtime.lastError?.message || "téléchargement refusé"
        });
      } else {
        resolve({ ok: true, downloadId });
      }
    });
  });
}

// Renomme les téléchargements de l'extension : Chrome a déjà déterminé un nom
// et une extension fiables (URL, Content-Disposition, type MIME) ; on applique
// par-dessus le modèle de nom et le sous-dossier configurés.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const meta = pendingByUrl.get(item.url) || pendingByUrl.get(item.finalUrl);
  if (!meta) {
    suggest(); // téléchargement étranger à l'extension : comportement par défaut
    return;
  }
  const original = meta.providedFilename || item.filename.split(/[/\\]/).pop() || "image";
  const { base, ext } = splitExt(original);
  let name = applyFilenameTemplate(meta.filenameTemplate, {
    name: base,
    domain: meta.hostname,
    date: new Date()
  });
  if (ext) name += "." + ext;
  const folder = sanitizeSubfolder(meta.subfolder);
  suggest({ filename: folder ? `${folder}/${name}` : name, conflictAction: "uniquify" });
});

// --- Messages ----------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "download") {
    startDownload(msg, sender).then(sendResponse);
    return true; // réponse asynchrone
  }

  // Relais : rediffuse l'état de la touche à toutes les frames de l'onglet
  // émetteur (le keydown ne se produit que dans la frame qui a le focus).
  if (msg?.type === "key-hold" && sender.tab?.id !== undefined) {
    chrome.tabs
      .sendMessage(sender.tab.id, { type: "key-hold-broadcast", held: msg.held })
      .catch(() => {}); // onglets/frames sans listener : sans importance
  }
});
