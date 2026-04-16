# MINEFIELD v2.0 — Development Documentation

---

## Project Objective

The central goal of this project is to demonstrate the full capabilities of the **HTML5 `<canvas>` element** as a complete, self-sufficient rendering surface for an interactive application — without relying on any external framework, game engine, or UI library.

Every visual element the user sees — the board, the numbers, the HUD, the animations, the scanlines, the boot sequence, the game over screen — is drawn programmatically through the **Canvas 2D API**. The `<canvas>` tag in the HTML file is intentionally the only UI element; there are no `<div>` overlays for game state, no DOM manipulation for score display, no CSS transitions for animations. The project proves that a rich, responsive, animated interface can live entirely inside a single canvas.

---

## What Was Built

### 1. Core Game Engine

A complete, rules-accurate Minesweeper implementation was developed from scratch. The engine handles the full game lifecycle from an initial idle state through active play to either defeat or victory.

Key mechanics implemented:

- **Safe first click** — mines are placed *after* the player's first click, guaranteeing the starting cell and all its neighbours are always mine-free.
- **Flood fill reveal** — clicking an empty cell triggers a breadth-first expansion that automatically uncovers all connected empty regions, implemented iteratively to avoid stack overflow on large boards.
- **Flag cycling** — right-clicking an unrevealed cell cycles through three states: flagged, question mark, and empty.
- **Chord action** — middle-clicking or double-clicking a numbered cell reveals all its unflagged neighbours simultaneously, provided the correct number of flags are already placed. If the flags are wrong, the chord triggers a mine.
- **Three difficulty levels** — Beginner (9×9, 10 mines), Intermediate (16×16, 40 mines), and Expert (16×30, 99 mines).

---

### 2. Rendering System

The renderer is entirely decoupled from game logic and communicates with the engine only through a read-only state snapshot. It never modifies game data.

The visual design follows a **retro phosphor terminal** aesthetic: black backgrounds, bright green monospaced text, amber warning colours, and red danger tones. Every design decision reinforces the illusion of playing on a CRT monitor from the 1980s.

#### Boot Screen

On launch, an animated terminal sequence types out system initialisation messages line by line before presenting the difficulty menu. A blinking cursor indicates the system is awaiting input.

> **Screenshot — Boot sequence**
>
> *(place screenshot here)*

---

#### Game Board

The board is drawn as a grid of cells, each rendered according to its current state:

- **Unrevealed cells** use a dark green fill.
- **Flagged cells** use an amber-tinted background with a glowing `!` symbol, making them immediately distinct from unrevealed cells at a glance.
- **Question mark cells** use a muted green `?`.
- **Revealed empty cells** use a near-black fill.
- **Revealed numbered cells** display their count in a colour that shifts from bright green (1) through amber (3–4) to red (7) and white (8), each with a glow effect baked into the cell.
- **Mine cells** display a circular mine symbol with radiating spikes and a highlight, rendered in red.
- **Hover state** brightens the cell under the cursor with a green glow border for clear targeting feedback.

> **Screenshot — Active game board (Intermediate)**
>
> *(place screenshot here)*

---

#### HUD (Heads-Up Display)

A persistent status bar at the top of the canvas shows:

- **Mines remaining** — the total mine count minus placed flags, which can go negative.
- **Elapsed time** — a live MM:SS timer that starts on the first click.
- **Difficulty label** — the current level name.
- **Restart button** — a clickable `[ RESTART ]` button rendered entirely in canvas.
- **Audio indicator** — shows whether sound is enabled or muted.

> **Screenshot — HUD detail**
>
> *(place screenshot here)*

---

#### Animations

All animations are frame-rate independent, driven by `performance.now()` timestamps rather than frame counts.

- **Cell reveal** — a vertical scan effect sweeps down over the cell in 80ms as it is uncovered.
- **Flag placement** — a brief horizontal glitch displacement on the `!` character over several frames.
- **Explosion wave** — upon hitting a mine, a cascading reveal spreads outward from the origin. Each mine activates with a delay proportional to its Manhattan distance from the clicked cell, producing a visible shockwave across the board. Each exploding mine flashes white before settling to red.
- **Victory particles** — green squares emanate from the board with gravity, fading out over time.

> **Screenshot — Explosion wave mid-sequence**
>
> *(place screenshot here)*

---

#### Game Over & Victory Screens

Both end states are drawn as overlays directly on the board canvas.

The **Game Over** screen features a chromatic aberration effect on the title text — cyan and red copies are rendered at slight offsets and the offset oscillates over time, simulating the visual distortion of a damaged display.

The **Victory** screen displays final time and efficiency, with the title text pulsing in brightness.

> **Screenshot — Game Over screen**
>
> *(place screenshot here)*

> **Screenshot — Victory screen**
>
> *(place screenshot here)*

---

#### CRT Visual Effects

Three effects layer on top of all game content to reinforce the monitor aesthetic:

- **Scanlines** — horizontal lines of reduced opacity run across the full canvas, evenly spaced, simulating the physical scan rows of a CRT tube.
- **CRT border** — a glowing green rectangle frames the canvas edge, evoking the bezel of a phosphor monitor.
- **Flicker** — every four to six seconds, the canvas opacity briefly drops for 50ms, simulating the natural instability of a cathode ray tube.

> **Screenshot — Scanlines and CRT border visible**
>
> *(place screenshot here)*

---

### 3. Audio Engine

All sound effects are generated **procedurally at runtime** using the Web Audio API — there are no audio files of any kind. Sounds are synthesised from oscillators and noise buffers directly in JavaScript.

| Event | Sound character |
|---|---|
| Cell reveal | Short ascending sine wave blip |
| Flag placement | Brief noise burst with a low square tone |
| Mine explosion | White noise through a falling low-pass filter |
| Victory | Four-note ascending chime (C-E-G-C) |
| Boot sequence | Ascending sine tones on each text line |

Audio initialises lazily on the first user interaction to comply with browser autoplay policies. It can be muted and unmuted at any time with the M key.

---

### 4. Input System

| Action | Input |
|---|---|
| Reveal cell | Left click / Tap |
| Place / cycle flag | Right click / Long press (500ms) |
| Chord | Middle click / Double click / Double tap |
| Restart | R key or click `[ RESTART ]` |
| Change difficulty | Keys 1 / 2 / 3 |
| Mute / unmute | M key |
| Fullscreen | F key |

Touch support is fully implemented for mobile play, including long-press detection for flag placement and double-tap for chord.

---

### 5. Responsive Layout

The board scales dynamically to fill the available viewport. Cell size is calculated by fitting the grid into the screen area with a minimum of 16px and a maximum of 48px per cell. Layout recalculates on window resize with a 150ms debounce to avoid thrashing during drag-resize.

---

## Performance Architecture

Running a 60fps canvas game efficiently required several deliberate optimisations:

### Sprite Pre-rendering

Every distinct cell appearance — unrevealed, hover, flagged, question mark, numbers 1 through 8, and the static mine — is pre-rendered once into a small offscreen canvas when the board initialises. At render time, drawing a cell is a single `drawImage()` call. This eliminates `shadowBlur`, font assignment, and arc drawing from the per-frame hot loop, where they would otherwise execute hundreds of times per second.

### Scanline Pre-rendering

The scanline overlay is also pre-rendered into a full-size offscreen canvas once and composited each frame with a single `drawImage()`. The previous approach drew each horizontal line individually, amounting to roughly 150 `fillRect()` calls per frame.

### Dirty Cell Tracking

Only cells whose visual state has changed are redrawn each frame. The renderer maintains a set of dirty cell coordinates, populated when game logic mutates a cell (reveal, flag, explosion activation). Animating cells are added to the dirty set automatically. On a static board with no hover movement, the per-frame redraw cost is near zero.

### Batched Grid Lines

All grid lines are drawn as a single canvas path — one `beginPath()`, all vertical and horizontal line segments, one `stroke()` — rather than individual `strokeRect()` calls per cell.

### Conditional HUD Updates

The HUD is only redrawn when something visible actually changes: the displayed second advances, the mine count changes, or the audio state changes. On most frames the HUD is skipped entirely.

---

## Relationship to the Canvas Objective

This project is a direct study in what the `<canvas>` element can do when used as the sole rendering surface of an application. The specific claims it demonstrates:

**The canvas can replace DOM-based UI entirely.** Buttons, counters, timers, menus, and status indicators are all drawn with canvas primitives. The restart button is a drawn rectangle with drawn text; it has no HTML element behind it.

**The canvas supports rich animation without CSS.** All transitions — cell reveals, explosions, particles, pulsing glows — are implemented through frame-by-frame drawing with `requestAnimationFrame`. There is not a single CSS animation or transition in the project.

**The canvas can render text as a design element.** Typography is treated as a visual component: font face, size, colour, alignment, and glow are all set via the Canvas 2D API's text rendering methods. The retro aesthetic depends entirely on this.

**The canvas scales to interactive complexity.** Even the Expert board (480 cells) runs smoothly at 60fps with dirty rendering, offscreen caching, and batched paths — techniques drawn directly from canvas performance best practices.

**The canvas can host a complete game loop.** Input handling, physics (particles, gravity), state machines, timers, and audio are all coordinated through a single `requestAnimationFrame` loop that calls into the canvas each frame.

In short, this project uses the `<canvas>` element not as an embellishment alongside HTML, but as the application itself.

---

## File Structure

| File | Role |
|---|---|
| `index.html` | Entry point. Contains the `<canvas>` element, minimal CSS for centering, and the aria live region for accessibility. |
| `game.js` | Game engine. Owns all board state, rules, input binding, and the animation loop. Never touches the canvas. |
| `renderer.js` | Rendering system. Reads game state and draws everything onto the canvas. Never modifies game state. |
| `audio.js` | Audio engine. Procedurally generates all sound effects via Web Audio API. |
