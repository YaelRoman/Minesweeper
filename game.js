/**
 * MinesweeperGame — core game logic.
 * Handles board state, rules, input, and the main requestAnimationFrame loop.
 * Never touches the canvas directly; all rendering is delegated to Renderer.
 */
class MinesweeperGame {
  /** Available difficulty presets. */
  static DIFFICULTIES = {
    EASY:   { rows: 9,  cols: 9,  mines: 10,  label: 'BEGINNER' },
    MEDIUM: { rows: 16, cols: 16, mines: 40,  label: 'INTERMEDIATE' },
    HARD:   { rows: 50, cols: 50, mines: 1000, label: 'EXPERT' },
  };

  /** Game state machine values. */
  static STATE = {
    IDLE:      'IDLE',       // Boot / difficulty selection screen
    PRE_GAME:  'PRE_GAME',   // Board visible, mines not yet placed
    PLAYING:   'PLAYING',    // Active play
    GAME_OVER: 'GAME_OVER',  // Mine exploded
    VICTORY:   'VICTORY',    // All safe cells revealed
  };

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {AudioEngine} audio
   */
  constructor(canvas, audio) {
    this.canvas = canvas;
    this.audio = audio;
    this.renderer = null; // set after Renderer is constructed

    this.state = MinesweeperGame.STATE.IDLE;
    this.difficulty = 'EASY';
    this.board = [];
    this.rows = 0;
    this.cols = 0;
    this.totalMines = 0;
    this.flagCount = 0;
    this.revealedCount = 0;
    this.startTime = 0;
    this.elapsedTime = 0;
    this.lastTimestamp = 0;

    // Hover tracking
    this.hoverRow = -1;
    this.hoverCol = -1;

    // Explosion wave state
    this.explosionOrigin = null;   // { row, col }
    this.explosionQueue = [];      // sorted array of { row, col, delay }
    this.explosionStartTime = 0;

    // Victory particles
    this.particles = [];

    // Animation timing
    this._rafId = null;

    // Long-press for mobile flag placement
    this._longPressTimer = null;
    this._longPressTriggered = false;

    // Double-click chord tracking
    this._lastClickTime = 0;
    this._lastClickCell = null;

    this._bindEvents();
  }

  // ─────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────

  /**
   * Reset and prepare the board for a new game.
   * @param {string} difficulty - 'EASY' | 'MEDIUM' | 'HARD'
   */
  init(difficulty) {
    this.difficulty = difficulty;
    const cfg = MinesweeperGame.DIFFICULTIES[difficulty];
    this.rows = cfg.rows;
    this.cols = cfg.cols;
    this.totalMines = cfg.mines;
    this.flagCount = 0;
    this.revealedCount = 0;
    this.startTime = 0;
    this.elapsedTime = 0;
    this.hoverRow = -1;
    this.hoverCol = -1;
    this.explosionOrigin = null;
    this.explosionQueue = [];
    this.particles = [];
    this.state = MinesweeperGame.STATE.PRE_GAME;

    // Build empty board
    this.board = [];
    for (let r = 0; r < this.rows; r++) {
      this.board[r] = [];
      for (let c = 0; c < this.cols; c++) {
        this.board[r][c] = {
          isMine: false,
          isRevealed: false,
          isFlagged: false,
          isQuestionMark: false,
          adjacentMines: 0,
          // Animation state
          revealAnimProgress: 1, // start fully rendered for unrevealed cells
          revealAnimStart: 0,
          explodeAnimProgress: 0,
          explodeAnimStart: 0,
          isExploding: false,
          // Flag glitch effect
          flagGlitchFrames: 0,
          flagGlitchOffset: 0,
        };
      }
    }

    if (this.renderer) {
      this.renderer.resize();
    }
  }

  /**
   * Handle a left-click reveal on a cell.
   * @param {number} row
   * @param {number} col
   */
  handleLeftClick(row, col) {
    if (this.state === MinesweeperGame.STATE.IDLE) return;
    if (this.state === MinesweeperGame.STATE.GAME_OVER) return;
    if (this.state === MinesweeperGame.STATE.VICTORY) return;
    if (!this._inBounds(row, col)) return;

    const cell = this.board[row][col];
    if (cell.isRevealed || cell.isFlagged) return;

    // First click: place mines away from this cell
    if (this.state === MinesweeperGame.STATE.PRE_GAME) {
      this._placeMines(row, col);
      this._calculateAdjacency();
      this.state = MinesweeperGame.STATE.PLAYING;
      this.startTime = performance.now();
    }

    if (cell.isMine) {
      this._triggerGameOver(row, col);
      return;
    }

    this._revealCell(row, col);
    this.audio.playReveal();
    this._checkVictory();
  }

  /**
   * Handle a right-click to cycle flag → question → empty.
   * @param {number} row
   * @param {number} col
   */
  handleRightClick(row, col) {
    if (this.state !== MinesweeperGame.STATE.PLAYING &&
        this.state !== MinesweeperGame.STATE.PRE_GAME) return;
    if (!this._inBounds(row, col)) return;

    const cell = this.board[row][col];
    if (cell.isRevealed) return;

    if (!cell.isFlagged && !cell.isQuestionMark) {
      // Empty → Flag
      cell.isFlagged = true;
      this.flagCount++;
      cell.flagGlitchFrames = 6;
      cell.flagGlitchOffset = 0;
      this.audio.playFlag();
    } else if (cell.isFlagged) {
      // Flag → Question
      cell.isFlagged = false;
      this.flagCount--;
      cell.isQuestionMark = true;
    } else {
      // Question → Empty
      cell.isQuestionMark = false;
    }
    if (this.renderer) this.renderer.markCellDirty(row, col);
  }

  /**
   * Handle a chord action (middle click / double-left-click).
   * Reveals all neighbors if the number of adjacent flags equals adjacentMines.
   * @param {number} row
   * @param {number} col
   */
  handleChord(row, col) {
    if (this.state !== MinesweeperGame.STATE.PLAYING) return;
    if (!this._inBounds(row, col)) return;

    const cell = this.board[row][col];
    if (!cell.isRevealed || cell.adjacentMines === 0) return;

    const neighbors = this._getNeighbors(row, col);
    const flaggedCount = neighbors.filter(([r, c]) => this.board[r][c].isFlagged).length;

    if (flaggedCount !== cell.adjacentMines) return;

    let exploded = false;
    for (const [r, c] of neighbors) {
      const n = this.board[r][c];
      if (!n.isRevealed && !n.isFlagged) {
        if (n.isMine) {
          this._triggerGameOver(r, c);
          exploded = true;
          break;
        }
        this._revealCell(r, c);
        this.audio.playReveal();
      }
    }

    if (!exploded) {
      this._checkVictory();
    }
  }

  /**
   * Main update tick — called by the animation loop with delta time in ms.
   * @param {number} now - performance.now() timestamp
   */
  update(now) {
    const delta = now - (this.lastTimestamp || now);
    this.lastTimestamp = now;

    // Advance elapsed timer
    if (this.state === MinesweeperGame.STATE.PLAYING) {
      this.elapsedTime = now - this.startTime;
    }

    // Process explosion wave
    if (this.state === MinesweeperGame.STATE.GAME_OVER && this.explosionQueue.length > 0) {
      const elapsed = now - this.explosionStartTime;
      while (this.explosionQueue.length > 0 && this.explosionQueue[0].delay <= elapsed) {
        const { row, col } = this.explosionQueue.shift();
        const c = this.board[row][col];
        c.isExploding = true;
        c.isRevealed = true;
        c.explodeAnimStart = now;
        if (this.renderer) this.renderer.markCellDirty(row, col);
      }
    }

    // Advance reveal animations
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cell = this.board[r][c];
        if (cell.revealAnimStart > 0) {
          const t = (now - cell.revealAnimStart) / 80; // 80ms duration
          cell.revealAnimProgress = Math.min(1, t);
        }
        if (cell.isExploding) {
          const t = (now - cell.explodeAnimStart) / 300;
          cell.explodeAnimProgress = Math.min(1, t);
        }
        if (cell.flagGlitchFrames > 0) {
          cell.flagGlitchFrames--;
          cell.flagGlitchOffset = cell.flagGlitchFrames > 0
            ? (Math.random() * 4 - 2)
            : 0;
        }
      }
    }

    // Victory particles
    if (this.state === MinesweeperGame.STATE.VICTORY) {
      this._updateParticles(delta);
    }
  }

  /**
   * Returns a snapshot of the current game state for the Renderer.
   * The renderer should only READ this object, never mutate it.
   */
  getState() {
    return {
      state: this.state,
      board: this.board,
      rows: this.rows,
      cols: this.cols,
      totalMines: this.totalMines,
      flagCount: this.flagCount,
      minesLeft: this.totalMines - this.flagCount,
      elapsedTime: this.elapsedTime,
      difficulty: this.difficulty,
      difficultyLabel: MinesweeperGame.DIFFICULTIES[this.difficulty]?.label ?? this.difficulty,
      hoverRow: this.hoverRow,
      hoverCol: this.hoverCol,
      particles: this.particles,
      explosionOrigin: this.explosionOrigin,
    };
  }

  // ─────────────────────────────────────────────
  //  Private — board setup
  // ─────────────────────────────────────────────

  /**
   * Place mines randomly, excluding the safe zone around (safeRow, safeCol).
   * @param {number} safeRow
   * @param {number} safeCol
   */
  _placeMines(safeRow, safeCol) {
    const safeSet = new Set();
    for (const [r, c] of this._getNeighbors(safeRow, safeCol)) {
      safeSet.add(`${r},${c}`);
    }
    safeSet.add(`${safeRow},${safeCol}`);

    let placed = 0;
    const allCells = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (!safeSet.has(`${r},${c}`)) allCells.push([r, c]);
      }
    }

    // Fisher-Yates shuffle and take first N
    for (let i = allCells.length - 1; i > 0 && placed < this.totalMines; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allCells[i], allCells[j]] = [allCells[j], allCells[i]];
      placed++;
    }

    for (let i = allCells.length - this.totalMines; i < allCells.length; i++) {
      const [r, c] = allCells[i];
      this.board[r][c].isMine = true;
    }
  }

  /** Calculate adjacentMines count for all cells after mines are placed. */
  _calculateAdjacency() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.board[r][c].isMine) continue;
        let count = 0;
        for (const [nr, nc] of this._getNeighbors(r, c)) {
          if (this.board[nr][nc].isMine) count++;
        }
        this.board[r][c].adjacentMines = count;
      }
    }
  }

  // ─────────────────────────────────────────────
  //  Private — game mechanics
  // ─────────────────────────────────────────────

  /**
   * Reveal a single cell and trigger flood fill if empty.
   * @param {number} row
   * @param {number} col
   */
  _revealCell(row, col) {
    if (this.board[row][col].adjacentMines === 0) {
      this._floodFill(row, col);
    } else {
      const cell = this.board[row][col];
      if (!cell.isRevealed) {
        cell.isRevealed = true;
        cell.revealAnimStart = performance.now();
        cell.revealAnimProgress = 0;
        this.revealedCount++;
        if (this.renderer) this.renderer.markCellDirty(row, col);
      }
    }
  }

  /**
   * BFS flood fill — reveals connected empty cells.
   * Iterative to avoid stack overflow on large boards.
   * @param {number} startRow
   * @param {number} startCol
   */
  _floodFill(startRow, startCol) {
    const queue = [[startRow, startCol]];
    const visited = new Set();
    const now = performance.now();

    while (queue.length > 0) {
      const [r, c] = queue.shift();
      const key = `${r},${c}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const cell = this.board[r][c];
      if (cell.isFlagged || cell.isRevealed) continue;

      cell.isRevealed = true;
      cell.revealAnimStart = now;
      cell.revealAnimProgress = 0;
      this.revealedCount++;
      if (this.renderer) this.renderer.markCellDirty(r, c);

      if (cell.adjacentMines === 0 && !cell.isMine) {
        for (const [nr, nc] of this._getNeighbors(r, c)) {
          if (!visited.has(`${nr},${nc}`)) {
            queue.push([nr, nc]);
          }
        }
      }
    }
  }

  /** Check if all non-mine cells are revealed → trigger victory. */
  _checkVictory() {
    const safeCells = this.rows * this.cols - this.totalMines;
    if (this.revealedCount >= safeCells) {
      this.state = MinesweeperGame.STATE.VICTORY;
      this.elapsedTime = performance.now() - this.startTime;

      // Auto-flag remaining unflagged mines
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const cell = this.board[r][c];
          if (cell.isMine && !cell.isFlagged) {
            cell.isFlagged = true;
            this.flagCount++;
          }
        }
      }

      this.audio.playVictory();
      this._spawnVictoryParticles();

      const announcer = document.getElementById('aria-announcer');
      if (announcer) announcer.textContent = 'Mission complete! All mines neutralized.';
    }
  }

  /**
   * Initiate the cascading explosion sequence.
   * @param {number} row - Mine row that was clicked
   * @param {number} col - Mine col that was clicked
   */
  _triggerGameOver(row, col) {
    this.state = MinesweeperGame.STATE.GAME_OVER;
    this.explosionOrigin = { row, col };
    this.explosionStartTime = performance.now();

    const origin = this.board[row][col];
    origin.isExploding = true;
    origin.isRevealed = true;
    origin.explodeAnimStart = this.explosionStartTime;
    if (this.renderer) this.renderer.markCellDirty(row, col);

    // Build expansion wave for all other mines
    this.explosionQueue = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (r === row && c === col) continue;
        if (this.board[r][c].isMine) {
          const dist = Math.abs(r - row) + Math.abs(c - col);
          this.explosionQueue.push({ row: r, col: c, delay: dist * 80 });
        }
      }
    }
    this.explosionQueue.sort((a, b) => a.delay - b.delay);

    this.audio.playExplosion();

    const announcer = document.getElementById('aria-announcer');
    if (announcer) announcer.textContent = 'Game over. Mine detonated.';
  }

  // ─────────────────────────────────────────────
  //  Private — particles
  // ─────────────────────────────────────────────

  /** Spawn celebration particles for the victory screen. */
  _spawnVictoryParticles() {
    if (!this.renderer) return;
    const { boardOffsetX, boardOffsetY, cellSize } = this.renderer;
    const boardW = this.cols * cellSize;
    const boardH = this.rows * cellSize;

    for (let i = 0; i < 80; i++) {
      this.particles.push({
        x: boardOffsetX + Math.random() * boardW,
        y: boardOffsetY + Math.random() * boardH,
        vx: (Math.random() - 0.5) * 2,
        vy: -Math.random() * 3 - 1,
        life: 1.0,
        decay: Math.random() * 0.008 + 0.004,
        size: Math.random() * 3 + 1,
      });
    }
  }

  /**
   * Update victory particle positions.
   * @param {number} delta - ms since last frame
   */
  _updateParticles(delta) {
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05; // gravity
      p.life -= p.decay;
    }
    this.particles = this.particles.filter(p => p.life > 0);

    // Spawn new ones while victory is displayed
    if (this.particles.length < 60 && this.renderer) {
      this._spawnVictoryParticles();
    }
  }

  // ─────────────────────────────────────────────
  //  Private — helpers
  // ─────────────────────────────────────────────

  /**
   * Return valid neighbor coordinates for (row, col).
   * @param {number} row
   * @param {number} col
   * @returns {Array<[number,number]>}
   */
  _getNeighbors(row, col) {
    const result = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr;
        const nc = col + dc;
        if (this._inBounds(nr, nc)) result.push([nr, nc]);
      }
    }
    return result;
  }

  /**
   * @param {number} row
   * @param {number} col
   * @returns {boolean}
   */
  _inBounds(row, col) {
    return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
  }

  // ─────────────────────────────────────────────
  //  Event handling
  // ─────────────────────────────────────────────

  /** Bind all mouse, keyboard, and touch events. */
  _bindEvents() {
    const canvas = this.canvas;

    // Mouse events
    canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._onRightClick(e);
    });
    canvas.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this._onMiddleClick(e);
      }
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverRow = -1;
      this.hoverCol = -1;
    });

    // Keyboard
    window.addEventListener('keydown', (e) => this._onKeyDown(e));

    // Touch
    canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    canvas.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  _onMouseMove(e) {
    if (!this.renderer) return;
    const { row, col } = this._pixelToCell(e);
    this.hoverRow = row;
    this.hoverCol = col;
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    if (!this.renderer) return;

    // Initialize audio context on first user gesture
    this.audio._ensureContext();

    const { row, col } = this._pixelToCell(e);

    // Check HUD restart button
    if (this.renderer.isRestartButton(e.offsetX, e.offsetY)) {
      if (this.state === MinesweeperGame.STATE.IDLE) return;
      this.init(this.difficulty);
      return;
    }

    // Boot / difficulty selection
    if (this.state === MinesweeperGame.STATE.IDLE) {
      // handled via keydown; clicking difficulty options is also supported
      const key = this.renderer.getDifficultyKeyAt(e.offsetX, e.offsetY);
      if (key) this._selectDifficulty(key);
      return;
    }

    // Game over / victory → restart on click
    if (this.state === MinesweeperGame.STATE.GAME_OVER ||
        this.state === MinesweeperGame.STATE.VICTORY) {
      // Let renderer handle "press R to retry" click anywhere
      this.init(this.difficulty);
      return;
    }

    // Double-click chord detection
    const now = performance.now();
    if (this._lastClickCell &&
        this._lastClickCell[0] === row &&
        this._lastClickCell[1] === col &&
        now - this._lastClickTime < 350) {
      this.handleChord(row, col);
      this._lastClickTime = 0;
      this._lastClickCell = null;
      return;
    }
    this._lastClickTime = now;
    this._lastClickCell = [row, col];

    this.handleLeftClick(row, col);
  }

  _onRightClick(e) {
    if (!this.renderer) return;
    const { row, col } = this._pixelToCell(e);
    this.handleRightClick(row, col);
  }

  _onMiddleClick(e) {
    if (!this.renderer) return;
    const { row, col } = this._pixelToCell(e);
    this.handleChord(row, col);
  }

  _onKeyDown(e) {
    switch (e.key.toLowerCase()) {
      case 'r': this.init(this.difficulty); break;
      case '1': this._selectDifficulty('EASY'); break;
      case '2': this._selectDifficulty('MEDIUM'); break;
      case '3': this._selectDifficulty('HARD'); break;
      case 'm': {
        const on = this.audio.toggle();
        // Brief visual feedback could go here
        break;
      }
      case 'f':
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
        break;
    }
  }

  _selectDifficulty(key) {
    this.audio._ensureContext();
    this.audio.playBoot();
    this.init(key);
  }

  _onTouchStart(e) {
    e.preventDefault();
    this.audio._ensureContext();
    const touch = e.touches[0];
    const rect = this.canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    const { row, col } = this.renderer ? this.renderer.screenToCell(x, y) : { row: -1, col: -1 };

    this._longPressTriggered = false;
    this._longPressTimer = setTimeout(() => {
      this._longPressTriggered = true;
      this.handleRightClick(row, col);
    }, 500);

    // Double-tap chord
    const now = performance.now();
    if (this._lastClickCell &&
        this._lastClickCell[0] === row &&
        this._lastClickCell[1] === col &&
        now - this._lastClickTime < 400) {
      clearTimeout(this._longPressTimer);
      this.handleChord(row, col);
      this._lastClickTime = 0;
      this._lastClickCell = null;
      return;
    }
    this._lastClickTime = now;
    this._lastClickCell = [row, col];
    this._touchRow = row;
    this._touchCol = col;
  }

  _onTouchEnd(e) {
    e.preventDefault();
    clearTimeout(this._longPressTimer);
    if (!this._longPressTriggered) {
      this.handleLeftClick(this._touchRow, this._touchCol);
    }
  }

  /**
   * Convert a mouse event to board [row, col].
   * @param {MouseEvent} e
   * @returns {{ row: number, col: number }}
   */
  _pixelToCell(e) {
    if (!this.renderer) return { row: -1, col: -1 };
    return this.renderer.screenToCell(e.offsetX, e.offsetY);
  }

  // ─────────────────────────────────────────────
  //  Animation loop
  // ─────────────────────────────────────────────

  /** Start the requestAnimationFrame loop. */
  startLoop() {
    const loop = (now) => {
      this.update(now);
      if (this.renderer) {
        this.renderer.render(this.getState());
      }
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }
}

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game-canvas');
  const audio = new AudioEngine();
  const game = new MinesweeperGame(canvas, audio);
  const renderer = new Renderer(canvas, game);
  game.renderer = renderer;

  // Show boot screen first
  game.state = MinesweeperGame.STATE.IDLE;
  renderer.resize();
  renderer.startBootSequence();

  game.startLoop();

  // Resize handling with debounce
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderer.resize(), 150);
  });
});
