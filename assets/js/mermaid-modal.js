(function () {
  var mermaidSeq = 0;

  function ensureModal() {
    var existing = document.getElementById("mermaid-modal");
    if (existing) return existing;

    var modal = document.createElement("div");
    modal.id = "mermaid-modal";
    modal.className = "mermaid-modal";
    // Fallback inline styles (in case custom CSS cache/style loading fails)
    modal.style.display = "none";
    modal.style.position = "fixed";
    modal.style.inset = "0";
    modal.style.zIndex = "99999";
    modal.innerHTML =
      '<div class="mermaid-modal__backdrop" data-close="1"></div>' +
      '<div class="mermaid-modal__panel" role="dialog" aria-modal="true" aria-label="Mermaid diagram preview">' +
      '  <button class="mermaid-modal__close" type="button" aria-label="Close" data-close="1">×</button>' +
      '  <div class="mermaid-modal__content"></div>' +
      "</div>";
    document.body.appendChild(modal);

    var backdrop = modal.querySelector(".mermaid-modal__backdrop");
    var panel = modal.querySelector(".mermaid-modal__panel");
    if (backdrop) {
      backdrop.style.position = "absolute";
      backdrop.style.inset = "0";
      backdrop.style.background = "rgba(0,0,0,0.56)";
    }
    if (panel) {
      var isDark = document.body.classList.contains("theme--dark");
      panel.style.position = "absolute";
      panel.style.top = "50%";
      panel.style.left = "50%";
      panel.style.transform = "translate(-50%, -50%)";
      panel.style.width = "min(94vw, 1200px)";
      panel.style.maxHeight = "88vh";
      panel.style.overflow = "auto";
      panel.style.borderRadius = "12px";
      panel.style.background = isDark ? "#1b2430" : "#fff";
      panel.style.padding = "18px 18px 14px";
      panel.style.boxShadow = "0 20px 60px rgba(0,0,0,0.3)";
    }

    modal.addEventListener("click", function (e) {
      if (e.target && e.target.getAttribute("data-close") === "1") {
        closeModal();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });

    return modal;
  }

  function openModal(contentNode) {
    var modal = ensureModal();
    var container = modal.querySelector(".mermaid-modal__content");
    container.innerHTML = "";
    container.appendChild(contentNode);
    modal.classList.add("is-open");
    modal.style.display = "block";
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    var modal = document.getElementById("mermaid-modal");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.style.display = "none";
    document.body.style.overflow = "";
  }

  function createZoomButton(block) {
    var btn = document.createElement("button");
    btn.className = "mermaid-zoom-icon-btn";
    btn.type = "button";
    btn.title = "放大查看";
    btn.setAttribute("aria-label", "放大查看");
    btn.setAttribute("data-mermaid-target", block.id);
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">' +
      '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.8"></circle>' +
      '<path d="M16.65 16.65L21 21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>' +
      '<path d="M11 8.5v5M8.5 11h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>' +
      "</svg>";
    // Direct binding fallback: guarantees click works even if delegated listener is blocked.
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openForTarget(block.id);
    });
    return btn;
  }

  function openForTarget(targetId) {
    var block = document.getElementById(targetId);
    if (!block) return;
    var svg = block.querySelector("svg");
    var cloneTarget = svg || block;
    var clone = cloneTarget.cloneNode(true);
    openModal(clone);
  }

  function wrapMermaidBlock(block) {
    if (block.parentElement && block.parentElement.classList.contains("mermaid-zoom-wrap")) {
      return block.parentElement;
    }
    var wrapper = document.createElement("div");
    wrapper.className = "mermaid-zoom-wrap";
    block.parentNode.insertBefore(wrapper, block);
    wrapper.appendChild(block);
    return wrapper;
  }

  function enhanceMermaidBlocks() {
    // Cleanup legacy buttons from old script versions.
    document.querySelectorAll(
      ".mermaid-zoom-btn, .mermaid-zoom-button, .diagram-zoom-btn, .diagram-zoom-button"
    ).forEach(function (oldBtn) {
      oldBtn.remove();
    });

    var blocks = document.querySelectorAll(
      ".post__content .mermaid, .post-content .mermaid, .post .mermaid"
    );
    blocks.forEach(function (block) {
      if (block.closest(".mermaid-modal")) return;

      // If old marker exists but wrapper/button is missing, re-init.
      if (block.dataset.zoomEnhanced === "1") {
        var wrapped = block.parentElement && block.parentElement.classList.contains("mermaid-zoom-wrap");
        var hasBtn = wrapped && block.parentElement.querySelector(".mermaid-zoom-icon-btn");
        if (wrapped && hasBtn) return;
        block.dataset.zoomEnhanced = "0";
      }

      if (block.dataset.zoomEnhanced === "1") return;
      if (!block.id) {
        mermaidSeq += 1;
        block.id = "mermaid-diagram-" + mermaidSeq;
      }
      block.dataset.zoomEnhanced = "1";
      var wrapper = wrapMermaidBlock(block);
      wrapper.classList.add("mermaid-zoom-wrap");

      // Remove duplicated/legacy zoom controls in current wrapper.
      wrapper.querySelectorAll(
        ".mermaid-zoom-icon-btn, .mermaid-zoom-btn, .mermaid-zoom-button, .diagram-zoom-btn, .diagram-zoom-button"
      ).forEach(function (btn) {
        btn.remove();
      });
      wrapper.querySelectorAll("button, a").forEach(function (el) {
        var title = (el.getAttribute("title") || "") + " " + (el.getAttribute("aria-label") || "");
        var text = (el.textContent || "").trim();
        var maybeLegacy = /放大|zoom/i.test(title) || /放大|zoom/i.test(text);
        if (maybeLegacy && !el.classList.contains("mermaid-zoom-icon-btn")) {
          el.remove();
        }
      });

      var btn = createZoomButton(block);
      wrapper.appendChild(btn);
    });
  }

  function init() {
    enhanceMermaidBlocks();

    document.addEventListener("click", function (e) {
      var btn = e.target.closest(".mermaid-zoom-icon-btn");
      if (!btn) return;
      e.preventDefault();
      var target = btn.getAttribute("data-mermaid-target");
      if (!target) return;
      openForTarget(target);
    });

    var observer = new MutationObserver(function () {
      enhanceMermaidBlocks();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
