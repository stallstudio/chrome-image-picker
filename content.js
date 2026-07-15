// Content script — cœur du mode sélection : gestion de la touche maintenue,
// surbrillance de l'image survolée et téléchargement au clic.
(() => {
  "use strict";

  const MAX_ANCESTORS = 6; // profondeur de remontée pour la détection

  let settings = { ...DEFAULTS };
  let localKeyHeld = false;  // touche maintenue dans cette frame
  let remoteKeyHeld = false; // touche maintenue dans une autre frame (relais SW)
  let active = false;
  let currentTarget = null;  // { el, type: "img" | "bg", url? }
  let lastMouseX = -1;
  let lastMouseY = -1;

  let overlay = null;
  let overlayTag = null;
  let toast = null;
  let toastTimer = 0;

  // --- Overlay de surbrillance et toast --------------------------------------

  function ensureOverlay() {
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement("div");
      overlay.id = "cip-overlay";
      overlayTag = document.createElement("span");
      overlayTag.id = "cip-overlay-tag";
      overlay.appendChild(overlayTag);
      document.documentElement.appendChild(overlay);
    }
    return overlay;
  }

  function showOverlay(rect, label) {
    const el = ensureOverlay();
    el.style.display = "block";
    el.style.left = rect.left + "px";
    el.style.top = rect.top + "px";
    el.style.width = rect.width + "px";
    el.style.height = rect.height + "px";
    overlayTag.textContent = label;
    overlayTag.style.display = label ? "inline-block" : "none";
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = "none";
  }

  function flashOverlay() {
    if (!overlay) return;
    overlay.classList.add("cip-overlay-flash");
    setTimeout(() => overlay && overlay.classList.remove("cip-overlay-flash"), 300);
  }

  function showToast(message, isError) {
    if (!toast || !toast.isConnected) {
      toast = document.createElement("div");
      toast.id = "cip-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle("cip-toast-error", Boolean(isError));
    toast.classList.add("cip-toast-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("cip-toast-visible"), 1800);
  }

  // --- Détection de la cible sous le curseur ---------------------------------

  function findTarget(x, y) {
    if (x < 0 || y < 0) return null;

    // Chaînes candidat + ancêtres pour chaque élément sous le point : gère le
    // motif courant du lien/div transparent qui recouvre une vignette.
    const chains = [];
    for (const start of document.elementsFromPoint(x, y)) {
      const chain = [];
      let el = start;
      for (let d = 0; el && el.nodeType === 1 && d <= MAX_ANCESTORS; d++, el = el.parentElement) {
        chain.push(el);
      }
      chains.push(chain);
    }

    // Les <img> sont prioritaires sur les SVG/canvas, eux-mêmes prioritaires
    // sur les fonds CSS.
    for (const chain of chains) {
      for (const el of chain) {
        if (el instanceof HTMLImageElement && (el.currentSrc || el.src)) {
          return { el, type: "img" };
        }
      }
    }

    if (settings.detectExtras) {
      for (const chain of chains) {
        for (const el of chain) {
          // Un enfant de SVG (path, rect…) désigne son <svg> racine.
          if (el instanceof SVGElement) {
            return { el: el.ownerSVGElement || el, type: "svg" };
          }
          if (el instanceof HTMLCanvasElement) {
            return { el, type: "canvas" };
          }
        }
      }
    }

    if (settings.detectBackgrounds) {
      for (const chain of chains) {
        for (const el of chain) {
          // html/body exclus : leurs fonds de page transformeraient tout
          // survol en surbrillance pleine fenêtre.
          if (el === document.documentElement || el === document.body) continue;
          const bg = firstUrlFromBackgroundImage(getComputedStyle(el).backgroundImage);
          if (bg) return { el, type: "bg", url: bg };
        }
      }
    }

    return null;
  }

  function positionOverlay() {
    if (!currentTarget) return;
    const rect = currentTarget.el.getBoundingClientRect();
    let label = "";
    if (currentTarget.type === "img") {
      const { naturalWidth: w, naturalHeight: h } = currentTarget.el;
      if (w && h) label = `${w} × ${h}`;
    } else if (currentTarget.type === "canvas") {
      label = `${currentTarget.el.width} × ${currentTarget.el.height}`;
    } else if (currentTarget.type === "svg") {
      label = "SVG";
    }
    showOverlay(rect, label);
  }

  function updateTarget() {
    currentTarget = active ? findTarget(lastMouseX, lastMouseY) : null;
    if (currentTarget) {
      positionOverlay();
    } else {
      hideOverlay();
    }
  }

  // --- Activation --------------------------------------------------------------

  function computeActive() {
    const next = settings.enabled || localKeyHeld || remoteKeyHeld;
    if (next === active) return;
    active = next;
    document.documentElement.classList.toggle("cip-active", active);
    updateTarget();
  }

  function setLocalKeyHeld(held) {
    if (held === localKeyHeld) return;
    localKeyHeld = held;
    // Diffuse la transition aux autres frames via le service worker.
    try {
      chrome.runtime.sendMessage({ type: "key-hold", held }).catch(() => {});
    } catch {
      // Contexte d'extension invalidé (extension rechargée) : ignorer.
    }
    computeActive();
  }

  // --- Clavier -------------------------------------------------------------------

  // Ne pas voler une touche imprimable pendant la saisie de texte.
  function isEditableTarget(e) {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(t instanceof Element)) return false;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== settings.shortcutCode) return;
      if (e.key.length === 1 && isEditableTarget(e)) return;
      e.preventDefault();
      // e.repeat accepté : réarme l'état si le keydown initial a eu lieu dans
      // une autre frame (l'auto-répétition se produit dans la frame focalisée).
      setLocalKeyHeld(true);
    },
    true
  );

  window.addEventListener(
    "keyup",
    (e) => {
      if (e.code !== settings.shortcutCode) return;
      e.preventDefault();
      setLocalKeyHeld(false);
    },
    true
  );

  // Le keyup se perd si la fenêtre perd le focus (Alt+Tab, changement
  // d'onglet, focus dans une autre frame) : forcer le relâchement.
  window.addEventListener("blur", () => setLocalKeyHeld(false));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setLocalKeyHeld(false);
  });

  // --- Souris ---------------------------------------------------------------------

  window.addEventListener(
    "mousemove",
    (e) => {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      if (active) updateTarget();
    },
    true
  );

  // L'élément sous le curseur change au défilement : re-détecter.
  window.addEventListener(
    "scroll",
    () => {
      if (active) updateTarget();
    },
    { capture: true, passive: true }
  );
  window.addEventListener("resize", () => {
    if (active) updateTarget();
  });

  // --- Choix de la meilleure URL ---------------------------------------------------

  function pickBestUrl(target) {
    if (target.type === "bg") return target.url; // déjà absolue (style calculé)

    const img = target.el;
    const candidates = parseSrcset(img.getAttribute("srcset"));
    const picture = img.closest("picture");
    if (picture) {
      // Les filtres media/type sont ignorés volontairement : on veut la plus
      // grande ressource, pas celle qui correspond à l'affichage courant.
      for (const source of picture.querySelectorAll("source[srcset]")) {
        candidates.push(...parseSrcset(source.getAttribute("srcset")));
      }
    }

    let best = null;
    const withW = candidates.filter((c) => c.w);
    if (withW.length) {
      best = withW.reduce((a, b) => (b.w > a.w ? b : a));
    } else if (candidates.length) {
      best = candidates.reduce((a, b) => ((b.x || 1) > (a.x || 1) ? b : a));
    }

    const url = best ? best.url : img.currentSrc || img.src;
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }

  // --- Téléchargement ---------------------------------------------------------------

  // Un blob: d'un autre document est inaccessible au service worker :
  // le convertir ici en data: URL.
  async function blobUrlToDownloadMessage(blobUrl) {
    const blob = await (await fetch(blobUrl)).blob();
    const ext = ((blob.type.split("/")[1] || "png").split("+")[0] || "png").replace("jpeg", "jpg");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("lecture du blob impossible"));
      reader.readAsDataURL(blob);
    });
    return { type: "download", url: dataUrl, filename: `image-${Date.now()}.${ext}` };
  }

  // Construit le message de téléchargement selon le type de cible.
  async function buildDownloadMessage(target) {
    if (target.type === "svg") {
      // Sérialise le SVG inline en data: URL autonome.
      const svg = target.el.cloneNode(true);
      if (!svg.getAttribute("xmlns")) {
        svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      }
      const source = new XMLSerializer().serializeToString(svg);
      return {
        type: "download",
        url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source),
        filename: `image-${Date.now()}.svg`
      };
    }
    if (target.type === "canvas") {
      // Lève SecurityError si le canvas est teinté par du contenu cross-origin.
      return {
        type: "download",
        url: target.el.toDataURL("image/png"),
        filename: `image-${Date.now()}.png`
      };
    }
    const url = pickBestUrl(target);
    if (!url) return null;
    if (url.startsWith("blob:")) return blobUrlToDownloadMessage(url);
    return { type: "download", url };
  }

  async function handlePick(target) {
    showToast("Téléchargement de l'image…");
    try {
      const message = await buildDownloadMessage(target);
      if (!message) {
        showToast("Impossible de déterminer l'URL de l'image", true);
        return;
      }
      const res = await chrome.runtime.sendMessage(message);
      if (res && res.ok) {
        showToast("Image téléchargée");
        flashOverlay();
      } else {
        showToast(`Échec du téléchargement : ${res?.error || "erreur inconnue"}`, true);
      }
    } catch (err) {
      const friendly =
        err?.name === "SecurityError" ? "canvas protégé (cross-origin)" : err?.message || err;
      showToast(`Échec du téléchargement : ${friendly}`, true);
    }
  }

  // --- Interception du clic ------------------------------------------------------------

  // Toute la séquence est supprimée pour qu'aucun handler de la page (lien,
  // lightbox, routeur SPA) ne réagisse. Les clics hors image passent normalement.
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "auxclick"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!active || !currentTarget) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === "click" && e.button === 0) {
          handlePick(currentTarget);
        }
      },
      true
    );
  }

  // --- Réglages et messages --------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in settings) settings[key] = newValue;
    }
    if (changes.shortcutCode) setLocalKeyHeld(false);
    computeActive();
    updateTarget(); // prend en compte detectBackgrounds sans changement d'état actif
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "key-hold-broadcast") {
      remoteKeyHeld = Boolean(msg.held);
      computeActive();
    }
  });

  chrome.storage.sync.get(DEFAULTS).then((stored) => {
    settings = stored;
    computeActive();
  });
})();
