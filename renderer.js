/**
 * Renderer — draws all game visuals onto the canvas.
 * Never modifies game state; only reads via game.getState().
 *
 * Performance strategy:
 *  - Cell sprites: each visual state (unrevealed, revealed, number 1-8, flag, ?)
 *    is pre-rendered to a small offscreen canvas on resize().  Per-frame drawing
 *    is then a single drawImage() call per cell — no shadowBlur, no font sets,
 *    no strokeRect inside the hot loop.
 *  - Scanlines: pre-rendered once to an offscreen canvas; composited with
 *    one drawImage() per frame instead of ~150 fillRect calls.
 *  - Dirty tracking: only cells whose visual state changed are redrawn.
 *    Static boards (no animations, no hover change) cost nearly zero GPU work.
 *  - Grid lines: drawn as a single batched path rather than per-cell strokeRect.
 *  - HUD: redrawn only when the displayed second or mine count changes.
 */
class Renderer {
  static NUMBER_COLORS = [
    null,
    '#39ff14',  // 1
    '#57ff4a',  // 2
    '#ffb300',  // 3
    '#ff8c00',  // 4
    '#ff5555',  // 5
    '#ff3333',  // 6
    '#ff1111',  // 7
    '#ffffff',  // 8
  ];

  static COLORS = {
    bgVoid:      '#000000',
    bgTerminal:  '#0a0f0a',
    greenDim:    '#1a3a1a',
    greenMid:    '#2d6e2d',
    greenBright: '#39ff14',
    greenGlow:   '#57ff4a',
    greenMuted:  '#4a7c4a',
    amberWarn:   '#ffb300',
    redMine:     '#ff3333',
    whiteFlash:  '#e8ffe8',
  };

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {MinesweeperGame} game
   */
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;

    this.cellSize = 32;
    this.boardOffsetX = 0;
    this.boardOffsetY = 0;
    this.hudHeight = 64;
    this.restartBtn = { x: 0, y: 0, w: 0, h: 0 };

    // ── Sprite cache (offscreen canvases, rebuilt on resize) ──────────────
    this._sprites = {};           // keyed by descriptive name
    this._scanlineCanvas = null;  // full-canvas scanline texture

    // ── Dirty-cell tracking ───────────────────────────────────────────────
    // Stores "row,col" strings. Cleared after each cell is redrawn.
    this._dirtySet = new Set();
    this._fullRedrawNeeded = true; // force complete repaint after resize/init

    // ── HUD change detection ──────────────────────────────────────────────
    this._lastHudSecond = -1;
    this._lastMinesLeft = NaN;
    this._lastAudioEnabled = null;

    // ── Hover tracking for dirty marking ─────────────────────────────────
    this._prevHoverRow = -1;
    this._prevHoverCol = -1;

    // ── Boot sequence ─────────────────────────────────────────────────────
    this._bootLines = [];
    this._bootDone = false;
    this._bootTimer = null;
    this._difficultyAreas = [];

    // ── Cursor blink ──────────────────────────────────────────────────────
    this._cursorVisible = true;
    this._cursorTimer = setInterval(() => { this._cursorVisible = !this._cursorVisible; }, 530);

    // ── CRT flicker ───────────────────────────────────────────────────────
    this._isFlickering = false;
    this._scheduleFlicker();

    // ── Game-over "all exploded" cache ────────────────────────────────────
    this._allExploded = false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════════

  /** Recalculate layout and rebuild all sprite/scanline caches. */
  resize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PADDING = 20;
    const state = this.game.getState();

    if (state.state === MinesweeperGame.STATE.IDLE) {
      const w = Math.min(640, vw - PADDING * 2);
      const h = Math.min(480, vh - PADDING * 2);
      this.canvas.width = w;
      this.canvas.height = h;
      this._setWrapperSize(w, h);
      return;
    }

    const { rows, cols } = state;
    const availW = vw - PADDING * 2;
    const availH = vh - this.hudHeight - PADDING * 2;
    const cellByW = Math.floor(availW / cols);
    const cellByH = Math.floor(availH / rows);
    this.cellSize = Math.min(Math.max(Math.min(cellByW, cellByH), 16), 48);

    const boardW = cols * this.cellSize;
    const boardH = rows * this.cellSize;
    const totalW = boardW + PADDING * 2;
    const totalH = boardH + this.hudHeight + PADDING * 2;

    this.canvas.width = totalW;
    this.canvas.height = totalH;
    this.boardOffsetX = PADDING;
    this.boardOffsetY = this.hudHeight + PADDING;
    this._setWrapperSize(totalW, totalH);

    const btnW = Math.round(this.cellSize * 4);
    const btnH = Math.round(this.hudHeight * 0.5);
    this.restartBtn = {
      x: Math.round(totalW / 2 - btnW / 2),
      y: Math.round((this.hudHeight - btnH) / 2),
      w: btnW,
      h: btnH,
    };

    this._buildSprites();
    this._buildScanlineCanvas(totalW, totalH);
    this._fullRedrawNeeded = true;
    this._allExploded = false;
    this._lastHudSecond = -1;
    this._lastMinesLeft = NaN;
  }

  /**
   * Main render entry point — called every animation frame.
   * @param {Object} state
   */
  render(state) {
    const ctx = this.ctx;
    ctx.globalAlpha = this._isFlickering ? 0.92 : 1.0;

    if (state.state === MinesweeperGame.STATE.IDLE) {
      this._drawBootScreen();
      this._composeScanlines();
      this._drawCRTBorder();
      ctx.globalAlpha = 1.0;
      return;
    }

    // ── Full repaint (first frame after resize/init) ─────────────────────
    if (this._fullRedrawNeeded) {
      ctx.fillStyle = Renderer.COLORS.bgTerminal;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this._drawAllCells(state);
      this._drawGridLines(state);
      this._drawHUD(state);
      this._composeScanlines();
      this._drawCRTBorder();
      this._fullRedrawNeeded = false;
      ctx.globalAlpha = 1.0;
      return;
    }

    // ── Hover change: mark both old and new cell dirty ───────────────────
    const { hoverRow, hoverCol } = state;
    if (hoverRow !== this._prevHoverRow || hoverCol !== this._prevHoverCol) {
      this._markDirty(this._prevHoverRow, this._prevHoverCol, state);
      this._markDirty(hoverRow, hoverCol, state);
      this._prevHoverRow = hoverRow;
      this._prevHoverCol = hoverCol;
    }

    // Mark animating cells dirty every frame
    this._markAnimatingCells(state);

    // ── Redraw dirty cells ───────────────────────────────────────────────
    if (this._dirtySet.size > 0) {
      for (const key of this._dirtySet) {
        const [r, c] = key.split(',').map(Number);
        this._redrawCell(r, c, state);
      }
      this._dirtySet.clear();
      // Redraw grid lines over the repainted cells
      this._drawGridLines(state);
    }

    // ── HUD (only when something visible changed) ────────────────────────
    const currentSecond = Math.floor(state.elapsedTime / 1000);
    if (currentSecond !== this._lastHudSecond ||
        state.minesLeft !== this._lastMinesLeft ||
        this.game.audio.enabled !== this._lastAudioEnabled) {
      this._drawHUD(state);
      this._lastHudSecond = currentSecond;
      this._lastMinesLeft = state.minesLeft;
      this._lastAudioEnabled = this.game.audio.enabled;
    }

    // ── Overlay screens ──────────────────────────────────────────────────
    if (state.state === MinesweeperGame.STATE.GAME_OVER) {
      this._drawGameOverScreen(state);
    } else if (state.state === MinesweeperGame.STATE.VICTORY) {
      this._drawParticles(state);
      this._drawVictoryScreen(state);
    }

    this._composeScanlines();
    this._drawCRTBorder();
    ctx.globalAlpha = 1.0;
  }

  /** Convert canvas pixel coordinates to {row, col}. */
  screenToCell(x, y) {
    return {
      col: Math.floor((x - this.boardOffsetX) / this.cellSize),
      row: Math.floor((y - this.boardOffsetY) / this.cellSize),
    };
  }

  /** Returns true if (x,y) is inside the restart button. */
  isRestartButton(x, y) {
    const b = this.restartBtn;
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }

  /** Returns difficulty key if (x,y) hits a boot-screen option, else null. */
  getDifficultyKeyAt(x, y) {
    for (const a of this._difficultyAreas) {
      if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) return a.key;
    }
    return null;
  }

  /** Mark a cell as needing a redraw. Called from game.js on state changes. */
  markCellDirty(row, col) {
    this._dirtySet.add(`${row},${col}`);
  }

  /** Start the animated boot text reveal. */
  startBootSequence() {
    this._bootLines = [];
    this._bootDone = false;
    const lines = [
      '> INITIALIZING MINEFIELD v2.0...',
      '> LOADING EXPLOSIVE MODULES...  [OK]',
      '> CALIBRATING PROXIMITY SENSORS... [OK]',
      '> SEEDING RANDOM MINE PLACEMENT... [OK]',
      '> SYSTEM READY.',
      '',
      '> SELECT DIFFICULTY:',
      '>  [1] BEGINNER       (9x9,   10 mines)',
      '>  [2] INTERMEDIATE   (16x16, 40 mines)',
      '>  [3] EXPERT         (50x50, 1000 mines)',
    ];
    const addLine = (i) => {
      if (i >= lines.length) { this._bootDone = true; return; }
      this._bootLines.push(lines[i]);
      this.game.audio.playTick();
      this._bootTimer = setTimeout(() => addLine(i + 1), 130);
    };
    addLine(0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Sprite cache
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Pre-render every static cell appearance into small offscreen canvases.
   * Called once on resize(). Expensive operations (shadowBlur, arc, text)
   * happen here, not in the hot render loop.
   */
  _buildSprites() {
    const cs = this.cellSize;
    const C = Renderer.COLORS;
    this._sprites = {};

    // Helper: create a cs×cs offscreen canvas and return [canvas, ctx]
    const make = () => {
      const oc = document.createElement('canvas');
      oc.width = cs; oc.height = cs;
      return [oc, oc.getContext('2d')];
    };

    // ── unrevealed ───────────────────────────────────────────────────────
    {
      const [oc, ox] = make();
      ox.fillStyle = C.greenDim;
      ox.fillRect(0, 0, cs, cs);
      this._sprites.unrevealed = oc;
    }

    // ── unrevealed hover ─────────────────────────────────────────────────
    {
      const [oc, ox] = make();
      ox.fillStyle = '#223322';
      ox.fillRect(0, 0, cs, cs);
      ox.shadowColor = C.greenGlow;
      ox.shadowBlur = 10;
      ox.strokeStyle = C.greenGlow;
      ox.lineWidth = 1.5;
      ox.strokeRect(1, 1, cs - 2, cs - 2);
      ox.shadowBlur = 0;
      this._sprites.unrevealedHover = oc;
    }

    // ── revealed empty ───────────────────────────────────────────────────
    {
      const [oc, ox] = make();
      ox.fillStyle = '#050f05';
      ox.fillRect(0, 0, cs, cs);
      this._sprites.revealed = oc;
    }

    // ── flag ─────────────────────────────────────────────────────────────
    {
      const [oc, ox] = make();
      // Amber-tinted background so flagged cells stand out at a glance
      ox.fillStyle = '#2a1a00';
      ox.fillRect(0, 0, cs, cs);
      // Subtle amber border
      ox.strokeStyle = 'rgba(255,179,0,0.5)';
      ox.lineWidth = 1;
      ox.strokeRect(0.5, 0.5, cs - 1, cs - 1);
      ox.font = `bold ${Math.round(cs * 0.55)}px 'Share Tech Mono', monospace`;
      ox.fillStyle = C.amberWarn;
      ox.shadowColor = C.amberWarn;
      ox.shadowBlur = 10;
      ox.textAlign = 'center';
      ox.textBaseline = 'middle';
      ox.fillText('!', cs / 2, cs / 2);
      ox.shadowBlur = 0;
      this._sprites.flag = oc;
    }

    // ── question mark ────────────────────────────────────────────────────
    {
      const [oc, ox] = make();
      ox.fillStyle = C.greenDim;
      ox.fillRect(0, 0, cs, cs);
      ox.font = `bold ${Math.round(cs * 0.5)}px 'Share Tech Mono', monospace`;
      ox.fillStyle = C.greenMuted;
      ox.shadowColor = C.greenBright;
      ox.shadowBlur = 5;
      ox.textAlign = 'center';
      ox.textBaseline = 'middle';
      ox.fillText('?', cs / 2, cs / 2);
      ox.shadowBlur = 0;
      this._sprites.question = oc;
    }

    // ── numbers 1-8 ──────────────────────────────────────────────────────
    for (let n = 1; n <= 8; n++) {
      const [oc, ox] = make();
      ox.fillStyle = '#050f05';
      ox.fillRect(0, 0, cs, cs);
      const color = Renderer.NUMBER_COLORS[n];
      ox.font = `bold ${Math.round(cs * 0.58)}px 'Share Tech Mono', monospace`;
      ox.fillStyle = color;
      ox.shadowColor = color;
      ox.shadowBlur = 8;
      ox.textAlign = 'center';
      ox.textBaseline = 'middle';
      ox.fillText(String(n), cs / 2, cs / 2);
      ox.shadowBlur = 0;
      this._sprites[`num${n}`] = oc;
    }

    // ── static mine (post-explosion, fully revealed) ─────────────────────
    {
      const [oc, ox] = make();
      ox.fillStyle = '#200000';
      ox.fillRect(0, 0, cs, cs);
      this._drawMineOnCtx(ox, 0, 0, cs, 1, false);
      this._sprites.mine = oc;
    }
  }

  /**
   * Pre-render the scanline texture into a full-canvas offscreen canvas.
   * @param {number} w
   * @param {number} h
   */
  _buildScanlineCanvas(w, h) {
    const oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    const ox = oc.getContext('2d');
    const lineH = 1;
    ox.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < h; y += lineH * 3) {
      ox.fillRect(0, y, w, lineH);
    }
    this._scanlineCanvas = oc;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Dirty tracking helpers
  // ═══════════════════════════════════════════════════════════════════════

  _markDirty(row, col, state) {
    if (row >= 0 && row < state.rows && col >= 0 && col < state.cols) {
      this._dirtySet.add(`${row},${col}`);
    }
  }

  /** Mark all cells that have active animations as dirty each frame. */
  _markAnimatingCells(state) {
    const { board, rows, cols } = state;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = board[r][c];
        if ((cell.revealAnimStart > 0 && cell.revealAnimProgress < 1) ||
            cell.isExploding ||
            cell.flagGlitchFrames > 0) {
          this._dirtySet.add(`${r},${c}`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Board drawing
  // ═══════════════════════════════════════════════════════════════════════

  /** Draw every cell unconditionally (used on first frame / after resize). */
  _drawAllCells(state) {
    const { rows, cols } = state;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this._redrawCell(r, c, state);
      }
    }
  }

  /**
   * Repaint a single cell from its current state.
   * This is the hot path: uses drawImage(sprite) wherever possible.
   */
  _redrawCell(row, col, state) {
    const { board, hoverRow, hoverCol } = state;
    const cell = board[row][col];
    const ctx = this.ctx;
    const cs = this.cellSize;
    const px = this.boardOffsetX + col * cs;
    const py = this.boardOffsetY + row * cs;
    const isHover = row === hoverRow && col === hoverCol;

    if (!cell.isRevealed) {
      // Pick sprite
      if (isHover) {
        ctx.drawImage(this._sprites.unrevealedHover, px, py);
      } else if (cell.isFlagged) {
        // Flag with optional glitch offset
        if (cell.flagGlitchFrames > 0) {
          // For glitch: draw amber base + shifted text manually (only a few frames)
          ctx.fillStyle = '#2a1a00';
          ctx.fillRect(px, py, cs, cs);
          ctx.save();
          ctx.rect(px, py, cs, cs);
          ctx.clip();
          const C = Renderer.COLORS;
          ctx.font = `bold ${Math.round(cs * 0.55)}px 'Share Tech Mono', monospace`;
          ctx.fillStyle = C.amberWarn;
          ctx.shadowColor = C.amberWarn;
          ctx.shadowBlur = 10;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('!', px + cs / 2 + (cell.flagGlitchOffset || 0), py + cs / 2);
          ctx.shadowBlur = 0;
          ctx.restore();
        } else {
          ctx.drawImage(this._sprites.flag, px, py);
        }
      } else if (cell.isQuestionMark) {
        ctx.drawImage(this._sprites.question, px, py);
      } else {
        ctx.drawImage(this._sprites.unrevealed, px, py);
      }
      return;
    }

    // ── Revealed ──────────────────────────────────────────────────────────
    if (cell.isExploding) {
      this._drawExplodingCell(cell, px, py, cs);
      return;
    }

    if (cell.isMine) {
      ctx.drawImage(this._sprites.mine, px, py);
      return;
    }

    // Reveal scan animation: clip sprite to animated height
    if (cell.revealAnimProgress < 1) {
      const revealH = Math.max(1, Math.floor(cs * cell.revealAnimProgress));
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, cs, revealH);
      ctx.clip();
      if (cell.adjacentMines > 0) {
        ctx.drawImage(this._sprites[`num${cell.adjacentMines}`], px, py);
      } else {
        ctx.drawImage(this._sprites.revealed, px, py);
      }
      // Fill remaining part with unrevealed color
      ctx.restore();
      ctx.fillStyle = Renderer.COLORS.greenDim;
      ctx.fillRect(px, py + revealH, cs, cs - revealH);
      return;
    }

    // Fully revealed, static
    if (cell.adjacentMines > 0) {
      ctx.drawImage(this._sprites[`num${cell.adjacentMines}`], px, py);
    } else {
      ctx.drawImage(this._sprites.revealed, px, py);
    }
  }

  /** Draw a mine cell that is currently in its explosion animation. */
  _drawExplodingCell(cell, px, py, cs) {
    const ctx = this.ctx;
    const p = cell.explodeAnimProgress;

    if (p < 0.15) {
      const intensity = Math.floor((1 - p / 0.15) * 255);
      ctx.fillStyle = `rgb(${intensity},${intensity},${intensity})`;
    } else {
      const alpha = Math.max(0, 1 - (p - 0.15) / 0.85);
      ctx.fillStyle = `rgba(40,0,0,${0.7 + alpha * 0.3})`;
    }
    ctx.fillRect(px, py, cs, cs);
    this._drawMineOnCtx(ctx, px, py, cs, p, true);
  }

  /**
   * Draw the mine symbol directly onto a given context.
   * Used by both _buildSprites (offscreen) and _drawExplodingCell (on-screen).
   */
  _drawMineOnCtx(ctx, px, py, cs, progress, isExploding) {
    const cx = px + cs / 2;
    const cy = py + cs / 2;
    const r = cs * 0.28;

    let color = '#ff3333';
    let glowBlur = 12;

    if (isExploding && progress < 0.15) {
      color = '#ffffff';
      glowBlur = 20;
    } else if (isExploding) {
      glowBlur = 6 + (1 - (progress - 0.15) / 0.85) * 14;
    }

    ctx.shadowColor = color;
    ctx.shadowBlur = glowBlur;

    if (isExploding && progress > 0.05) {
      const expR = r * (1 + progress * 1.5);
      ctx.beginPath();
      ctx.arc(cx, cy, expR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,50,0,${Math.max(0, 0.6 - progress * 0.6)})`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, cs * 0.06);
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * r * 0.9, cy + Math.sin(angle) * r * 0.9);
      ctx.lineTo(cx + Math.cos(angle) * r * 1.6, cy + Math.sin(angle) * r * 1.6);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx - r * 0.25, cy - r * 0.25, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = isExploding && progress < 0.3 ? 'rgba(255,255,255,0.9)' : 'rgba(255,200,200,0.6)';
    ctx.fill();

    ctx.shadowBlur = 0;
  }

  /**
   * Draw all grid lines as a single batched canvas path — one stroke call
   * instead of per-cell strokeRect.
   */
  _drawGridLines(state) {
    const ctx = this.ctx;
    const { rows, cols } = state;
    const cs = this.cellSize;
    const ox = this.boardOffsetX;
    const oy = this.boardOffsetY;

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(45, 110, 45, 0.35)';
    ctx.lineWidth = 0.5;

    // Vertical lines
    for (let c = 0; c <= cols; c++) {
      const x = ox + c * cs;
      ctx.moveTo(x, oy);
      ctx.lineTo(x, oy + rows * cs);
    }
    // Horizontal lines
    for (let r = 0; r <= rows; r++) {
      const y = oy + r * cs;
      ctx.moveTo(ox, y);
      ctx.lineTo(ox + cols * cs, y);
    }

    ctx.stroke();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  HUD
  // ═══════════════════════════════════════════════════════════════════════

  _drawHUD(state) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.hudHeight;
    const C = Renderer.COLORS;

    ctx.fillStyle = '#050f05';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = C.greenMid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h); ctx.lineTo(w, h);
    ctx.stroke();

    const fs = Math.round(h * 0.38);
    const fsSmall = Math.round(fs * 0.65);

    // Mines
    const minesLeft = state.minesLeft;
    const minesStr = (minesLeft < 0 ? '-' : '') + String(Math.abs(minesLeft)).padStart(3, '0');
    ctx.font = `${fs}px 'VT323', monospace`;
    ctx.fillStyle = C.greenBright;
    ctx.shadowColor = C.greenBright;
    ctx.shadowBlur = 6;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`MINES: ${minesStr}`, 12, h * 0.38);

    ctx.font = `${fsSmall}px 'VT323', monospace`;
    ctx.fillStyle = C.greenMuted;
    ctx.shadowBlur = 0;
    ctx.fillText(state.difficultyLabel, 12, h * 0.78);

    // Timer
    const totalSecs = Math.floor(state.elapsedTime / 1000);
    const timeStr = `TIME: ${String(Math.floor(totalSecs / 60)).padStart(2, '0')}:${String(totalSecs % 60).padStart(2, '0')}`;
    ctx.font = `${fs}px 'VT323', monospace`;
    ctx.fillStyle = C.greenBright;
    ctx.shadowBlur = 6;
    ctx.textAlign = 'right';
    ctx.fillText(timeStr, w - 12, h * 0.38);

    ctx.font = `${Math.round(fs * 0.6)}px 'VT323', monospace`;
    ctx.fillStyle = this.game.audio.enabled ? C.greenMuted : '#ff3333';
    ctx.shadowBlur = 0;
    ctx.fillText(this.game.audio.enabled ? '[M] SOUND ON' : '[M] MUTED', w - 12, h * 0.78);

    // Restart button
    const b = this.restartBtn;
    ctx.shadowColor = C.greenGlow;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = C.greenBright;
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = C.bgVoid;
    ctx.fillRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
    ctx.fillStyle = C.greenBright;
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(b.h * 0.7)}px 'VT323', monospace`;
    ctx.fillText('[ RESTART ]', b.x + b.w / 2, b.y + b.h / 2);
    ctx.shadowBlur = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Overlay screens
  // ═══════════════════════════════════════════════════════════════════════

  _drawBootScreen() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const C = Renderer.COLORS;

    ctx.fillStyle = C.bgTerminal;
    ctx.fillRect(0, 0, w, h);

    const fontSize = Math.round(Math.min(w / 38, 18));
    const lineSpacing = fontSize * 1.55;
    const paddingX = Math.round(w * 0.07);
    let lineY = Math.round(h * 0.12);

    this._difficultyAreas = [];

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `${fontSize}px 'Share Tech Mono', monospace`;

    for (let i = 0; i < this._bootLines.length; i++) {
      const line = this._bootLines[i];
      if (line === '') { lineY += lineSpacing; continue; }

      const isDimmed = i < 5 && this._bootLines.length > 7;
      const isOption = line.startsWith('>  [');

      ctx.fillStyle = isDimmed ? C.greenMuted : (isOption ? C.greenGlow : C.greenBright);
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = isDimmed ? 0 : (line.includes('[OK]') || isOption ? 4 : 2);
      ctx.fillText(line, paddingX, lineY);

      if (line.includes('[1]')) this._difficultyAreas.push({ key: 'EASY',   x: paddingX, y: lineY, w: w - paddingX * 2, h: lineSpacing });
      if (line.includes('[2]')) this._difficultyAreas.push({ key: 'MEDIUM', x: paddingX, y: lineY, w: w - paddingX * 2, h: lineSpacing });
      if (line.includes('[3]')) this._difficultyAreas.push({ key: 'HARD',   x: paddingX, y: lineY, w: w - paddingX * 2, h: lineSpacing });

      lineY += lineSpacing;
    }

    if (this._bootDone && this._cursorVisible) {
      ctx.shadowBlur = 4;
      ctx.fillStyle = C.greenBright;
      ctx.fillText('_', paddingX, lineY);
    }
    ctx.shadowBlur = 0;

    if (this._bootDone) {
      ctx.font = `${Math.round(fontSize * 0.85)}px 'Share Tech Mono', monospace`;
      ctx.fillStyle = C.greenMuted;
      ctx.textAlign = 'center';
      ctx.fillText('PRESS 1 / 2 / 3 OR CLICK TO SELECT', w / 2, h - fontSize * 2);
    }
  }

  _drawGameOverScreen(state) {
    const ctx = this.ctx;
    const C = Renderer.COLORS;

    // Cache the "all mines exploded" check — avoid flat().filter().every() each frame
    if (!this._allExploded) {
      let done = true;
      outer: for (let r = 0; r < state.rows; r++) {
        for (let c = 0; c < state.cols; c++) {
          const cell = state.board[r][c];
          if (cell.isMine && !cell.isRevealed) { done = false; break outer; }
        }
      }
      this._allExploded = done;
      if (!done) return;
    }

    const bx = this.boardOffsetX, by = this.boardOffsetY;
    const bw = state.cols * this.cellSize, bh = state.rows * this.cellSize;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, bw, bh);

    const cx = bx + bw / 2, cy = by + bh / 2;
    const fsBig = Math.round(Math.min(this.cellSize * 1.8, 42));
    const fsMid = Math.round(fsBig * 0.5);
    const glitch = Math.sin(performance.now() / 80) * 3;

    ctx.font = `${fsBig}px 'VT323', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(0,255,255,0.4)';
    ctx.fillText('GAME OVER', cx - glitch * 1.5, cy - 30 - 2);
    ctx.fillStyle = 'rgba(255,0,0,0.4)';
    ctx.fillText('GAME OVER', cx + glitch * 1.5, cy - 30 + 2);
    ctx.fillStyle = C.redMine;
    ctx.shadowColor = C.redMine;
    ctx.shadowBlur = 16;
    ctx.fillText('GAME OVER', cx, cy - 30);

    ctx.shadowBlur = 0;
    ctx.font = `${fsMid}px 'VT323', monospace`;
    ctx.fillStyle = C.greenMuted;
    ['> MINE DETONATED.', '> MISSION FAILED.', '', '> PRESS [R] TO RETRY', '> PRESS [1/2/3] CHANGE DIFFICULTY']
      .forEach((l, i) => ctx.fillText(l, cx, cy + 10 + i * fsMid * 1.2));
  }

  _drawVictoryScreen(state) {
    const ctx = this.ctx;
    const C = Renderer.COLORS;
    const bx = this.boardOffsetX, by = this.boardOffsetY;
    const bw = state.cols * this.cellSize, bh = state.rows * this.cellSize;
    const cx = bx + bw / 2, cy = by + bh / 2;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    const fsBig = Math.round(Math.min(this.cellSize * 1.8, 42));
    const fsMid = Math.round(fsBig * 0.5);

    ctx.fillStyle = `rgba(0,10,0,${0.45 + pulse * 0.1})`;
    ctx.fillRect(bx, by, bw, bh);

    ctx.font = `${fsBig}px 'VT323', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.greenBright;
    ctx.shadowColor = C.greenBright;
    ctx.shadowBlur = 20 + pulse * 10;
    ctx.fillText('MISSION COMPLETE', cx, cy - 35);

    ctx.shadowBlur = 0;
    ctx.font = `${fsMid}px 'VT323', monospace`;
    ctx.fillStyle = C.greenMuted;

    const totalSecs = Math.floor(state.elapsedTime / 1000);
    const efficiency = Math.round(((state.rows * state.cols - state.totalMines) / (state.rows * state.cols)) * 100);

    [`> TIME: ${String(Math.floor(totalSecs / 60)).padStart(2,'0')}:${String(totalSecs % 60).padStart(2,'0')}`,
     `> EFFICIENCY: ${efficiency}%`, '', '> PRESS [R] TO PLAY AGAIN']
      .forEach((l, i) => ctx.fillText(l, cx, cy + 5 + i * fsMid * 1.25));
  }

  _drawParticles(state) {
    const ctx = this.ctx;
    ctx.shadowColor = Renderer.COLORS.greenBright;
    ctx.shadowBlur = 4;
    ctx.fillStyle = Renderer.COLORS.greenBright;
    for (const p of state.particles) {
      ctx.globalAlpha = p.life;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1.0;
    ctx.shadowBlur = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Scanlines & CRT
  // ═══════════════════════════════════════════════════════════════════════

  /** Composite the pre-rendered scanline texture in one drawImage call. */
  _composeScanlines() {
    if (this._scanlineCanvas) {
      this.ctx.drawImage(this._scanlineCanvas, 0, 0);
    }
  }

  _drawCRTBorder() {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.strokeStyle = Renderer.COLORS.greenMid;
    ctx.lineWidth = 2;
    ctx.shadowColor = Renderer.COLORS.greenBright;
    ctx.shadowBlur = 6;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.shadowBlur = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════

  _setWrapperSize(w, h) {
    const wrapper = document.getElementById('game-wrapper');
    if (wrapper) { wrapper.style.width = w + 'px'; wrapper.style.height = h + 'px'; }
  }

  _scheduleFlicker() {
    const next = () => {
      setTimeout(() => {
        this._isFlickering = true;
        setTimeout(() => { this._isFlickering = false; next(); }, 50);
      }, 4500 + Math.random() * 2000);
    };
    next();
  }
}
