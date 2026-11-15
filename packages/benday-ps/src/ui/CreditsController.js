'use strict';

/**
 * CreditsController.js
 * Controls the theatrical crawling credits window & 1879 Ben Day Rapid Shading Medium
 * Broadside Easter Egg in Electrosaur: Benday.
 *
 * Features:
 * - Native scrollbars active immediately for unhurried browsing
 * - Gentle 24 px/sec ambient crawl yielding immediately to hover or wheel scroll
 * - Backdrop click dismisses Broadside first, then Credits overlay
 * - UXP-safe pure flexbox / explicit display toggling
 */
class CreditsController {
  /**
   * @param {HTMLElement|null} overlayEl - The #credits-overlay container
   */
  constructor(overlayEl) {
    this.overlay = overlayEl;
    if (!this.overlay) return;

    this.viewport = this.overlay.querySelector('#credits-viewport');
    this.crawl = this.overlay.querySelector('#credits-crawl');
    this.emblem = this.overlay.querySelector('#credits-emblem');
    this.printTrigger = this.overlay.querySelector('#credits-print-trigger');
    this.broadside = this.overlay.querySelector('#manifesto-broadside');
    this.manifestoHeader = this.overlay.querySelector('.manifesto-header');

    this.speed = 24; // pixels per second gentle ambient crawl
    this.isPlaying = false;
    this.isHovered = false;
    this.isManifestoOpen = false;
    this.userHasScrolled = false;
    this.lastTimestamp = 0;
    this.rafId = null;

    this._tick = this._tick.bind(this);
    this._bindEvents();
  }

  _bindEvents() {
    if (!this.overlay) return;

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        if (this.isManifestoOpen) {
          this.closeManifesto();
        } else {
          this.close();
        }
      }
    });

    if (this.manifestoHeader) {
      this.manifestoHeader.style.cursor = 'pointer';
      this.manifestoHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeManifesto();
      });
    }

    if (this.broadside) {
      this.broadside.addEventListener('click', () => {
        this.closeManifesto();
      });
    }

    if (this.viewport) {
      const onEnter = () => {
        this.isHovered = true;
      };
      const onLeave = () => {
        this.isHovered = false;
      };
      this.viewport.addEventListener('mouseenter', onEnter);
      this.viewport.addEventListener('mouseleave', onLeave);
      this.viewport.addEventListener('pointerenter', onEnter);
      this.viewport.addEventListener('pointerleave', onLeave);

      this.viewport.addEventListener('wheel', () => {
        this.pause();
        this.userHasScrolled = true;
      });
      this.viewport.addEventListener('pointerdown', () => {
        this.pause();
      });
    }

    const onTriggerDown = () => {
      this.pause();
    };
    const triggerManifesto = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      this.openManifesto();
    };

    if (this.emblem) {
      this.emblem.addEventListener('pointerdown', onTriggerDown);
      this.emblem.addEventListener('click', triggerManifesto);
    }
    if (this.printTrigger) {
      this.printTrigger.addEventListener('pointerdown', onTriggerDown);
      this.printTrigger.addEventListener('click', triggerManifesto);
    }
  }

  isOpen() {
    return !!(
      this.overlay &&
      this.overlay.style.display !== 'none' &&
      this.overlay.style.display !== ''
    );
  }

  open() {
    if (!this.overlay) return;
    this.closeManifesto();
    this.overlay.classList.add('visible');
    this.overlay.style.display = 'flex';
    this.userHasScrolled = false;
    this.isHovered = false;
    if (this.viewport) {
      this.viewport.scrollTop = 0;
    }
    this.play();
  }

  close() {
    if (!this.overlay) return;
    this.closeManifesto();
    this.pause();
    this.overlay.classList.remove('visible');
    this.overlay.style.display = 'none';
  }

  openManifesto() {
    if (!this.broadside) return;
    this.isManifestoOpen = true;
    this.pause();
    this.broadside.classList.add('visible');
    this.broadside.style.display = 'flex';
  }

  closeManifesto() {
    if (!this.broadside) return;
    this.isManifestoOpen = false;
    this.broadside.classList.remove('visible');
    this.broadside.style.display = 'none';
    if (this.isOpen() && !this.userHasScrolled) {
      this.play();
    }
  }

  play() {
    if (this.isManifestoOpen || this.userHasScrolled) return;
    this.isPlaying = true;
    this.lastTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!this.rafId && typeof requestAnimationFrame !== 'undefined') {
      this.rafId = requestAnimationFrame(this._tick);
    }
  }

  pause() {
    this.isPlaying = false;
    if (this.rafId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  destroy() {
    this.pause();
  }

  _tick(timestamp) {
    if (!this.isPlaying || this.isManifestoOpen || this.userHasScrolled) return;

    const ts = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const delta = Math.max(0, Math.min((ts - this.lastTimestamp) / 1000, 0.1));
    this.lastTimestamp = ts;

    if (!this.isHovered && this.viewport) {
      const maxScroll = this.viewport.scrollHeight - this.viewport.clientHeight;
      if (maxScroll <= 0 || this.viewport.scrollTop < maxScroll - 2) {
        this.viewport.scrollTop += this.speed * delta;
      } else {
        this.pause();
        return;
      }
    }

    if (this.isPlaying && typeof requestAnimationFrame !== 'undefined') {
      this.rafId = requestAnimationFrame(this._tick);
    }
  }
}

module.exports = { CreditsController };
