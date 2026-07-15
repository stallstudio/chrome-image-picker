// Popup : lit/écrit les réglages dans chrome.storage.sync. La propagation
// vers les onglets ouverts se fait via storage.onChanged (aucun messaging).

const enabledEl = document.getElementById("enabled");
const detectEl = document.getElementById("detect-backgrounds");
const extrasEl = document.getElementById("detect-extras");
const keyBtn = document.getElementById("key-capture");
const subfolderEl = document.getElementById("subfolder");
const templateEl = document.getElementById("filename-template");

let capturing = false;
let currentLabel = DEFAULTS.shortcutLabel;

chrome.storage.sync.get(DEFAULTS).then((s) => {
  enabledEl.checked = s.enabled;
  detectEl.checked = s.detectBackgrounds;
  extrasEl.checked = s.detectExtras;
  currentLabel = s.shortcutLabel;
  keyBtn.textContent = currentLabel;
  subfolderEl.value = s.subfolder;
  templateEl.value = s.filenameTemplate === DEFAULTS.filenameTemplate ? "" : s.filenameTemplate;
});

enabledEl.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabledEl.checked });
});

detectEl.addEventListener("change", () => {
  chrome.storage.sync.set({ detectBackgrounds: detectEl.checked });
});

extrasEl.addEventListener("change", () => {
  chrome.storage.sync.set({ detectExtras: extrasEl.checked });
});

// Champs texte : enregistrement différé pendant la frappe.
let saveTimer = 0;
function saveTextFields() {
  chrome.storage.sync.set({
    subfolder: subfolderEl.value.trim(),
    filenameTemplate: templateEl.value.trim() || DEFAULTS.filenameTemplate
  });
}
for (const el of [subfolderEl, templateEl]) {
  el.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveTextFields, 300);
  });
  el.addEventListener("change", saveTextFields);
}

// --- Capture de la touche raccourci -----------------------------------------

function stopCapture() {
  capturing = false;
  keyBtn.classList.remove("capturing");
  keyBtn.textContent = currentLabel;
}

keyBtn.addEventListener("click", () => {
  if (capturing) return;
  capturing = true;
  keyBtn.classList.add("capturing");
  keyBtn.textContent = "Appuyez sur une touche…";
  keyBtn.focus();
});

// Échap annule (et n'est donc pas assignable — voir le title du bouton).
window.addEventListener(
  "keydown",
  (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape") {
      stopCapture();
      return;
    }
    currentLabel = friendlyKeyLabel(e);
    chrome.storage.sync.set({ shortcutCode: e.code, shortcutLabel: currentLabel });
    stopCapture();
  },
  true
);

keyBtn.addEventListener("blur", () => {
  if (capturing) stopCapture();
});
