// Constantes et helpers partagés entre le popup, le content script et le
// service worker. Chargé comme script classique (pas de module) : les
// déclarations top-level sont visibles par les scripts chargés ensuite.

const DEFAULTS = {
  enabled: false,               // mode persistant (interrupteur du popup)
  shortcutCode: "AltLeft",      // event.code de la touche à maintenir
  shortcutLabel: "Alt gauche",  // libellé affiché dans le popup
  detectBackgrounds: false,     // détecter aussi les background-image CSS
  detectExtras: false,          // détecter aussi les SVG inline et les canvas
  subfolder: "",                // sous-dossier dans Téléchargements ("" = racine)
  filenameTemplate: "{name}"    // jetons : {name} {domain} {date} {time}
};

// "img1.jpg 480w, img2.jpg 2x" -> [{ url, w? , x? }]
// Simplification assumée : les URLs contenant des virgules (data:) sont rares
// dans un srcset et ne sont pas gérées.
function parseSrcset(srcset) {
  const out = [];
  if (!srcset) return out;
  for (const part of srcset.split(",")) {
    const tokens = part.trim().split(/\s+/);
    if (!tokens[0]) continue;
    const entry = { url: tokens[0] };
    const m = tokens[1] && /^(\d+(?:\.\d+)?)([wx])$/.exec(tokens[1]);
    if (m) entry[m[2]] = parseFloat(m[1]);
    out.push(entry);
  }
  return out;
}

// Extrait la première URL d'une valeur calculée de background-image.
// Les dégradés ne contiennent pas de url() et sont donc ignorés naturellement.
function firstUrlFromBackgroundImage(value) {
  if (!value || value === "none") return null;
  const m = /url\((['"]?)(.*?)\1\)/.exec(value);
  return m && m[2] ? m[2] : null;
}

// Nettoie un nom de fichier pour chrome.downloads (caractères interdits, longueur).
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 180);
}

// "Photos / 2026" -> "Photos/2026" : segments nettoyés, sans "." ni "..",
// sans segments vides. Retourne "" si rien d'exploitable (racine).
function sanitizeSubfolder(value) {
  return (value || "")
    .split("/")
    .map((s) => sanitizeFilename(s.trim()))
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

// Applique le modèle de nom de fichier (sans l'extension).
// parts : { name, domain, date: Date }
function applyFilenameTemplate(template, parts) {
  const d = parts.date;
  const pad = (n) => String(n).padStart(2, "0");
  const tokens = {
    "{name}": parts.name,
    "{domain}": parts.domain || "",
    "{date}": `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    "{time}": `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  };
  let out = template && template.trim() ? template.trim() : "{name}";
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  return sanitizeFilename(out) || sanitizeFilename(parts.name) || "image";
}

// Libellé français convivial pour la touche capturée dans le popup.
const KEY_LABELS = {
  AltLeft: "Alt gauche",
  AltRight: "Alt droite",
  ControlLeft: "Ctrl gauche",
  ControlRight: "Ctrl droite",
  ShiftLeft: "Maj gauche",
  ShiftRight: "Maj droite",
  MetaLeft: "Cmd gauche",
  MetaRight: "Cmd droite",
  Space: "Espace",
  Tab: "Tab",
  CapsLock: "Verr. maj",
  Enter: "Entrée",
  Backspace: "Retour arrière",
  ArrowUp: "Flèche haut",
  ArrowDown: "Flèche bas",
  ArrowLeft: "Flèche gauche",
  ArrowRight: "Flèche droite"
};

function friendlyKeyLabel(event) {
  if (KEY_LABELS[event.code]) return KEY_LABELS[event.code];
  if (/^F\d{1,2}$/.test(event.code)) return event.code;
  if (event.key && event.key.length === 1 && event.key.trim()) {
    return event.key.toUpperCase();
  }
  return event.code;
}
