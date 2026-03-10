// =============================================================================
//  PREMIUM 2D PLATFORMER  —  script.js
// =============================================================================

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// ── Physics ───────────────────────────────────────────────────────────────────
const GRAVITY = 0.6;
const FRICTION = 0.82;
const JUMP_POWER = -13;
const SPEED = 3.5;       // Base auto-walk speed
let currentSpeed = SPEED; // Dynamic speed for Phase 1

// ── Phase state ───────────────────────────────────────────────────────────────
let gamePhase = 1;
let phaseStartTime = Date.now();
let phase2StartTime = 0; // set when phase 2 actually starts
const PHASE_1_DURATION_MS = 20000; // 20 seconds transition

let transitioning = false;
let transitionStartTime = 0;
const TRANSITION_DURATION = 2000;

// ── Endless / Simulation state ────────────────────────────────────────────────
let worldX = 0;          // Total distance traveled
let cameraX = 0;         // Current viewport X
let score = 0;           // Current distance score
let gameOver = false;
let victory = false;     // Reaching the door in Phase 2
let uiAlpha = 0;         // For smooth text fade-ins
let isDying = false;      // For death animation

// ── Background & Parallax ─────────────────────────────────────────────────────
let bgFarX = 0;          // Far layer (slowest)
let bgMidX = 0;          // Mid layer (medium)
let bgScrollX = 0;       // Legacy tracker (fallback)

// ── Interaction State ────────────────────────────────────────────────────────
let mouseX = 0, mouseY = 0;
let screenMouseX = 0, screenMouseY = 0;

// ── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
function playExplosionSound() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(150, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
}

// ── Visual FX State ──────────────────────────────────────────────────────────
let screenShake = 0;
let radialFlashes = []; // {x, y, r, life}

// ── Entities ──────────────────────────────────────────────────────────────────
let platforms = [];
let spikes = [];
let crates = [];
let barriers = [];
let goalDoor = null;

// ── Interaction State ────────────────────────────────────────────────────────
let interactionCooldownEnd = 0;
const INTERACTION_COOLDOWN_MS = 1000;

// ── Procedural World Gen ──────────────────────────────────────────────────────
const GROUND_Y = 560;
const P1_SPIKE_INTERVAL = 800; // Phase 1: spike every 800px
let worldGenX = 0;

// ── Player ────────────────────────────────────────────────────────────────────
const player = {
    x: canvas.width / 2 - 15, // centered initially for infinite runner feel
    y: 0,
    w: 30, h: 30,
    vx: 0, vy: 0,
    color: '#FF3366',
    grounded: false,
};

// =============================================================================
//  INPUT
// =============================================================================

const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true; });
window.addEventListener('keyup', e => { keys[e.code] = false; });

/** Converts a MouseEvent to WORLD-space coordinates. */
function canvasMouse(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left) * (canvas.width / rect.width) + cameraX,
        y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
}

canvas.addEventListener('mousedown', e => {
    if (gameOver || victory) { restart(); return; }
    if (gamePhase !== 2) return;

    // Interaction Cooldown check
    const now = Date.now();
    if (now < interactionCooldownEnd) return;

    const m = canvasMouse(e);

    // 1. Crates (Click to shatter)
    for (let i = crates.length - 1; i >= 0; i--) {
        const c = crates[i];
        if (m.x >= c.x && m.x <= c.x + c.w && m.y >= c.y && m.y <= c.y + c.h) {
            interactionCooldownEnd = now + INTERACTION_COOLDOWN_MS;
            createCrateFragments(c.x + c.w / 2, c.y + c.h / 2);
            // Handle Linked Clusters
            if (c.clusterId) {
                crates = crates.filter(item => item.clusterId !== c.clusterId);
                spikes = spikes.filter(item => item.clusterId !== c.clusterId);
            } else {
                crates.splice(i, 1);
            }
            createBlast(c.x + c.w / 2, c.y + c.h / 2);
            return;
        }
    }

    // 2. Spikes (Click to disable)
    for (let i = spikes.length - 1; i >= 0; i--) {
        const s = spikes[i];
        if (m.x >= s.x && m.x <= s.x + s.w && m.y >= s.y && m.y <= s.y + s.h) {
            interactionCooldownEnd = now + INTERACTION_COOLDOWN_MS;
            s.disabledUntil = now + 2000;
            // Handle Linked Clusters
            if (s.clusterId) {
                spikes.forEach(item => { if (item.clusterId === s.clusterId) item.disabledUntil = now + 2000; });
            }
            createBlast(s.x + s.w / 2, s.y + s.h / 2);
            return;
        }
    }

    // 3. Barriers (Click to fade)
    for (let b of barriers) {
        if (m.x >= b.x && m.x <= b.x + b.w && m.y >= b.y && m.y <= b.y + b.h) {
            if (now > (b.disabledUntil || 0)) {
                interactionCooldownEnd = now + INTERACTION_COOLDOWN_MS;
                b.disabledUntil = now + 3300; // 0.3s fade + 3s down
                createBlast(b.x + b.w / 2, b.y + b.h / 2);
                return;
            }
        }
    }

    // 4. Dragging bridges
    for (const p of platforms) {
        if (p.draggable && m.x >= p.x && m.x <= p.x + p.w &&
            m.y >= p.y && m.y <= p.y + p.h) {
            draggedPlatform = p;
            dragOffsetX = m.x - p.x;
            canvas.style.cursor = 'grabbing';
            break;
        }
    }
});

let draggedPlatform = null;
let dragOffsetX = 0;

// Mouse interaction state (updated in mousemove)
canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    screenMouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    screenMouseY = (e.clientY - rect.top) * (canvas.height / rect.height);

    const m = canvasMouse(e);
    mouseX = m.x; mouseY = m.y;

    if (gamePhase !== 2) { canvas.style.cursor = 'default'; return; }
    if (draggedPlatform) {
        const minX = cameraX;
        const maxX = cameraX + canvas.width - draggedPlatform.w;
        draggedPlatform.x = Math.max(minX, Math.min(maxX, m.x - dragOffsetX));
    } else {
        const hover = platforms.some(p =>
            p.draggable && m.x >= p.x && m.x <= p.x + p.w &&
            m.y >= p.y && m.y <= p.y + p.h
        );
        canvas.style.cursor = hover ? 'grab' : 'default';
    }
});

window.addEventListener('mouseup', () => {
    draggedPlatform = null;
    canvas.style.cursor = 'default';
});

// ROTATE Mechanic: right-click to toggle vertical/horizontal
canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (gamePhase !== 2 || gameOver || victory) return;
    const m = canvasMouse(e);

    for (const p of platforms) {
        if (p.draggable && m.x >= p.x && m.x <= p.x + p.w &&
            m.y >= p.y && m.y <= p.y + p.h) {

            // Swap w/h and keep centered
            const cx = p.x + p.w / 2;
            const cy = p.y + p.h / 2;
            const temp = p.w;
            p.w = p.h;
            p.h = temp;
            p.x = cx - p.w / 2;
            p.y = cy - p.h / 2;

            createBlast(cx, cy); // reused for rotation feedback
            break;
        }
    }
});

// =============================================================================
//  LEVEL INITIALISATION
// =============================================================================

function init() {
    player.vy = 0;
    player.vx = 0;
    worldX = 0;
    cameraX = 0;
    score = 0;
    currentSpeed = SPEED; // Reset speed
    gameOver = false;
    victory = false;
    worldGenX = -canvas.width; // start generation behind screen

    if (gamePhase === 1) {
        // Phase 1: Grounded infinite runner position
        player.x = canvas.width / 2 - 15;
        player.y = GROUND_Y - player.h - 100;
        platforms = [];
        spikes = [];
        crates = [];
        barriers = [];
        particles = [];
        radialFlashes = [];
        generatePhase1World(canvas.width * 2);
    } else {
        // Phase 2: Switch to traveling mode
        phase2StartTime = Date.now();
        player.x = 50;
        player.y = 340;
        platforms = [
            { x: -100, y: GROUND_Y, w: 999999, h: 50, color: '#1a1a2e' },
            { x: 0, y: 370, w: 250, h: 20, color: '#34495E' }, // start platform (intro color)

            // 3 Rectangular Draggable Platforms (Distinct Teal)
            { x: 350, y: 370, w: 160, h: 20, color: '#0e9981', draggable: true },
            { x: 650, y: 370, w: 160, h: 20, color: '#0e9981', draggable: true },
            { x: 950, y: 370, w: 160, h: 20, color: '#0e9981', draggable: true }
        ];

        spikes = [];
        crates = [];
        barriers = [];
        radialFlashes = [];
        interactionCooldownEnd = 0;
        worldGenX = 1200; // Start procedural generation further out
        generatePhase2Chunks();
    }
}

function restart() {
    gamePhase = 1;
    phaseStartTime = Date.now();
    transitioning = false;
    init();
}

function handleDeath() {
    if (isDying) return;
    isDying = true;

    // Create 30 death particles at player location
    const px = gamePhase === 1 ? worldX + player.x : player.x;
    for (let i = 0; i < 30; i++) {
        particles.push({
            x: px + player.w / 2,
            y: player.y + player.h / 2,
            vx: (Math.random() - 0.5) * 12,
            vy: (Math.random() - 0.5) * 15 - 5, // Explode upwards
            life: 1.0,
            color: player.color,
            gravity: 0.3,
            size: 4 + Math.random() * 4
        });
    }

    // Delay restart by 1s
    setTimeout(() => {
        isDying = false;
        restart();
    }, 1000);
}

// =============================================================================
//  WORLD GENERATION
// =============================================================================

function generatePhase1World(targetX) {
    while (worldGenX < targetX) {
        // Simple gap every 1200px (starting after 1000px)
        const isGap = (worldGenX % 1200 === 0 && worldGenX > 1000);
        if (!isGap) {
            // Periodic moving platform every 2400px
            if (worldGenX % 2400 === 0 && worldGenX > 1500) {
                platforms.push({
                    x: worldGenX, y: GROUND_Y - 120,
                    w: 150, h: 20,
                    color: '#3498DB',
                    baseX: worldGenX,
                    type: 'moving_h'
                });
            } else {
                // Push ground segment
                platforms.push({ x: worldGenX, y: GROUND_Y, w: 101, h: 50, color: '#1a1a2e' });

                // Place spike on solid ground only
                if (worldGenX % P1_SPIKE_INTERVAL === 0 && worldGenX > 800) {
                    spikes.push({
                        x: worldGenX + 30, y: GROUND_Y - 20,
                        w: 40, h: 20, color: '#E74C3C'
                    });
                }

                // Place Box Obstacle between spikes (spaced at +400px from spikes)
                if (worldGenX % P1_SPIKE_INTERVAL === 400 && worldGenX > 1000) {
                    platforms.push({
                        x: worldGenX + 30, y: GROUND_Y - 40,
                        w: 40, h: 40, color: '#2c3e50', type: 'obstacle'
                    });
                }
            }
        }
        worldGenX += 100;
    }

    // Cull old entities for performance
    if (platforms.length > 50) {
        platforms = platforms.filter(p => p.x + p.w > worldX - 200 || gamePhase === 2);
        spikes = spikes.filter(s => s.x + s.w > worldX - 200);
    }
}

function generatePhase2Chunks() {
    const target = cameraX + canvas.width + 1200;
    const elapsed = Date.now() - phase2StartTime;

    while (worldGenX < target) {
        // PHASE 2.0: Setup & Intro (0-10s)
        // 0-3s is prep delay (stationary), 3-10s is safe intro walk.
        if (elapsed < 10000) {
            platforms.push({ x: worldGenX, y: 370, w: 400, h: 20, color: '#34495E' });
            worldGenX += 400;
            continue;
        }

        // PHASE 2.1: The Gap Challenge (10-25s)
        // Strictly isolated: only gaps and bridges.
        if (elapsed < 25000) {
            const gap = 160; // Reduced gap slightly
            const plat = 300;
            const platX = worldGenX + gap;

            platforms.push({ x: platX, y: 370, w: plat, h: 20, color: '#2C3E50' });
            if (!platforms.some(p => p.draggable && p.x > worldGenX - 250)) {
                // Spawn the bridge floating higher up so the player must interact with it
                platforms.push({
                    x: worldGenX - 50, y: 340, // Put it slightly out of reach so they must drag it
                    w: 220, h: 20, color: '#0e9981', draggable: true
                });
            }
            worldGenX += gap + plat;
            continue;
        }

        // PHASE 2.2: The Spike Challenge (25-40s)
        // Strictly isolated: only ground and clickable spikes.
        if (elapsed < 40000) {
            const plat = 400;
            platforms.push({ x: worldGenX, y: 370, w: plat, h: 20, color: '#2C3E50' });

            // Placed spikes directly on the platform instead of floating
            spikes.push({
                x: worldGenX + 180, y: 370 - 20, // Proper height grounded on 370
                w: 40, h: 20, color: '#E74C3C'
            });
            worldGenX += plat + 100;
            continue;
        }

        // PHASE 2.3: Crates (40-55s)
        if (elapsed < 55000) {
            const plat = 350;
            platforms.push({ x: worldGenX, y: 370, w: plat, h: 20, color: '#2C3E50' });
            crates.push({ x: worldGenX + 150, y: 370 - 40, w: 40, h: 40 });
            worldGenX += plat + 100;
            continue;
        }

        // PHASE 2.4: Energy Barriers (55-75s)
        if (elapsed < 75000) {
            const plat = 400;
            platforms.push({ x: worldGenX, y: 370, w: plat, h: 20, color: '#2C3E50' });
            barriers.push({ x: worldGenX + 200, y: 370 - 80, w: 20, h: 80 });
            worldGenX += plat + 100;
            continue;
        }

        // PHASE 2.5: High Ledges (75-100s)
        if (elapsed < 100000) {
            const gap = 180;
            const highPlatY = 220;
            platforms.push({ x: worldGenX + gap, y: highPlatY, w: 400, h: 20, color: '#2C3E50' });
            if (!platforms.some(p => p.draggable && p.x > worldGenX - 200)) {
                platforms.push({ x: worldGenX, y: 370, w: 140, h: 20, color: '#0e9981', draggable: true });
            }
            worldGenX += gap + 400;
            continue;
        }

        // FINAL GOAL (100s+)
        if (elapsed >= 100000 && !goalDoor) {
            platforms.push({ x: worldGenX, y: 370, w: 1000, h: 20, color: '#2C3E50' });
            goalDoor = { x: worldGenX + 500, y: 370 - 100, w: 60, h: 100, color: '#f1c40f' };
            worldGenX += 2000;
            break;
        }

        // Safety filler
        platforms.push({ x: worldGenX, y: 370, w: 500, h: 20, color: '#2C3E50' });
        worldGenX += 500;
    }
}

// ── Particles for "Blast" ───────
let particles = [];
function createBlast(x, y) {
    screenShake = 15;
    radialFlashes.push({ x, y, r: 0, life: 1.0 });
    playExplosionSound();
    for (let i = 0; i < 12; i++) {
        particles.push({
            x, y,
            vx: (Math.random() - 0.5) * 10,
            vy: (Math.random() - 0.5) * 10,
            life: 1.0,
            color: '#FF3366',
            size: 4
        });
    }
}

function createJumpParticles(x, y) {
    const count = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
        particles.push({
            x: x + Math.random() * 20 - 10,
            y: y + 5,
            vx: (Math.random() - 0.5) * 2,
            vy: -Math.random() * 2 - 1,
            life: 0.8 + Math.random() * 0.2,
            color: 'rgba(255, 255, 255, 0.4)',
            size: 2,
            grow: 0.15,
            type: 'bubble'
        });
    }
}

function createCrateFragments(x, y) {
    const count = 15 + Math.floor(Math.random() * 6);
    for (let i = 0; i < count; i++) {
        particles.push({
            x: x + Math.random() * 30 - 15,
            y: y + Math.random() * 30 - 15,
            vx: (Math.random() - 0.5) * 8,
            vy: (Math.random() - 0.5) * 8,
            gravity: 0.2,
            life: 1.0,
            color: '#E67E22', // Orange for crates
            size: 3 + Math.random() * 3,
            type: 'fragment'
        });
    }
}

// =============================================================================
//  UPDATE
// =============================================================================

function update() {
    if (gameOver || victory || transitioning || isDying) {
        // Still update particles during death/victory
        for (let p of particles) {
            p.x += p.vx; p.y += p.vy;
            if (p.gravity) p.vy += p.gravity;
            if (p.grow) p.size += p.grow;
            p.life *= (p.type === 'bubble' ? 0.94 : 0.95);
        }
        particles = particles.filter(p => p.life > 0.01);
        return;
    }

    // Movement
    if (gamePhase === 1) {
        // Gradually increase speed in Phase 1
        if (currentSpeed < 5.0) {
            currentSpeed += 0.001; // Slightly increase each frame
        }

        // Infinite runner simulation: character is "centered"
        // Horizontal inputs just tilt the eyes (handled in draw)
        // World / background moves right linearly
        worldX += currentSpeed;
        bgFarX += currentSpeed * 0.15;  // Far layer moves very slowly
        bgMidX += currentSpeed * 0.35;  // Mid layer moves slightly faster
        bgScrollX += currentSpeed * 0.4;

        generatePhase1World(worldX + canvas.width);
    } else {
        // Phase 2: Traveling runner - reduced to 60% of Phase 1 base speed
        const elapsedSinceStart = Date.now() - phase2StartTime;
        const PREP_DELAY = 3000; // 3 seconds setup time

        let phase2Speed = 0;
        if (elapsedSinceStart > PREP_DELAY) {
            phase2Speed = SPEED * 0.6;
            player.vx = phase2Speed;
            player.x += player.vx;
        } else {
            player.vx = 0;
        }

        cameraX = player.x - 150;
        bgScrollX += phase2Speed * 0.2;

        generatePhase2Chunks();
    }

    // Unified Jumping logic
    if ((keys['ArrowUp'] || keys['KeyW'] || keys['Space']) && player.grounded) {
        player.vy = JUMP_POWER;
        player.grounded = false;

        const px = gamePhase === 1 ? worldX + player.x : player.x;
        createJumpParticles(px + player.w / 2, player.y + player.h);
    }

    // Physics
    player.vy += GRAVITY;
    player.y += player.vy;

    // Platform Updates (Moving)
    const now = Date.now();
    for (const p of platforms) {
        if (p.type === 'moving_h') {
            const oldX = p.x;
            p.x = p.baseX + Math.sin(now / 1000) * 100;
            // If player is on this platform, move them too
            if (player.grounded && player.currentPlatform === p) {
                if (gamePhase === 1) {
                    // In Phase 1 "runner" mode, worldX is the scroll.
                    // To move the player relative to the world, we'd adjust player.x
                    // but since player is locked centered, we adjust worldX or just let it be.
                    // Actually, for Phase 1 centered player, horizontal moving platforms 
                    // should shift the player.x slightly or we shift the world.
                    // Simplest: player.x offset from center.
                    player.x += (p.x - oldX);
                } else {
                    player.x += (p.x - oldX);
                }
            }
        }
    }

    // Entity Collisions
    const checkCollision = (r1, r2) => r1.x < r2.x + r2.w && r1.x + r1.w > r2.x && r1.y < r2.y + r2.h && r1.y + r1.h > r2.y;

    // Adjust obstacles based on scrolling world for Phase 1
    const playerHitbox = {
        x: gamePhase === 1 ? worldX + player.x : player.x,
        y: player.y,
        w: player.w, h: player.h
    };

    // Platform Resolution (AABB Minkowski)
    for (const p of platforms) {
        if (!checkCollision(playerHitbox, p)) continue;

        const dx = (playerHitbox.x + playerHitbox.w / 2) - (p.x + p.w / 2);
        const dy = (playerHitbox.y + playerHitbox.h / 2) - (p.y + p.h / 2);
        const hw = (playerHitbox.w + p.w) / 2;
        const hh = (playerHitbox.h + p.h) / 2;
        const cw = hw * dy;
        const ch = hh * dx;

        if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) {
            if (cw > ch) {
                if (cw > -ch) { player.y = p.y + p.h; player.vy = 0; } // Head hit
            } else {
                if (!(cw > -ch)) {
                    // Landed
                    player.y = p.y - player.h;
                    player.vy = 0;
                    player.grounded = true;
                    player.currentPlatform = p;
                }
            }
        }
    }

    // Spikes - instant restart (only if active)
    for (const s of spikes) {
        const isActive = !s.disabledUntil || Date.now() > s.disabledUntil;
        if (isActive && checkCollision(playerHitbox, s)) {
            handleDeath();
            return;
        }
    }

    // Crates - block player
    for (const c of crates) {
        if (checkCollision(playerHitbox, c)) {
            // Very simple wall logic: push player back
            if (gamePhase === 1) {
                // Should not exist in Phase 1, but safety:
                worldX -= currentSpeed;
            } else {
                player.x = c.x - player.w;
                player.vx = 0;
            }
        }
    }

    // Barriers - lethal if active
    for (const b of barriers) {
        const now = Date.now();
        const fadeTime = 300;
        const totalDuration = 3300;
        const elapsed = b.disabledUntil ? now - (b.disabledUntil - totalDuration) : Infinity;

        let alpha = 1.0;
        if (elapsed < fadeTime) alpha = 1.0 - (elapsed / fadeTime);
        else if (elapsed < totalDuration - fadeTime) alpha = 0.0;
        else if (elapsed < totalDuration) alpha = (elapsed - (totalDuration - fadeTime)) / fadeTime;

        if (alpha > 0.5 && checkCollision(playerHitbox, b)) {
            handleDeath();
            return;
        }
    }

    // Goal Door
    if (goalDoor && checkCollision(playerHitbox, goalDoor)) {
        victory = true;
    }

    // Out of bounds
    if (player.y > canvas.height + 200) handleDeath();

    // Particle update
    for (let p of particles) {
        p.x += p.vx; p.y += p.vy;
        if (p.gravity) p.vy += p.gravity;
        if (p.grow) p.size += p.grow;
        p.life *= (p.type === 'bubble' ? 0.94 : 0.95);
    }
    particles = particles.filter(p => p.life > 0.01);

    // FX update
    if (screenShake > 0.1) screenShake *= 0.88;
    else screenShake = 0;

    for (let f of radialFlashes) {
        f.r += 6;
        f.life *= 0.9;
    }
    radialFlashes = radialFlashes.filter(f => f.life > 0.01);
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // ── Background (Screen Space) ─────────────────────────────────────────────
    const bgGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (gamePhase === 1) {
        // Phase 1: Sky blue to Cyan
        bgGrad.addColorStop(0, '#87CEEB');
        bgGrad.addColorStop(1, '#00FFFF');
    } else {
        // Phase 2: Deep Purple to Dark Indigo with breathing glow
        const glow = Math.sin(Date.now() / 2000) * 0.15 + 0.15;
        bgGrad.addColorStop(0, '#311040');
        bgGrad.addColorStop(0.5, `rgba(75, 0, 130, ${glow})`);
        bgGrad.addColorStop(1, '#0B011D');
    }
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // ── World Transform ──────────────────────────────────────────────────────
    ctx.save();
    // Screen Shake
    if (screenShake > 0.1) {
        ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
    }
    const worldScrollX = gamePhase === 1 ? -worldX : -cameraX;
    ctx.translate(worldScrollX, 0);

    // ── Parallax Background (Phase 1 Only) ────────────────────────────────────
    if (gamePhase === 1) {
        // Layer 1: Far
        ctx.save();
        ctx.translate(-bgFarX % 800, 0);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 15; j++) {
                ctx.beginPath();
                ctx.arc(i * 800 + (j * 57) % 800, (j * 137) % canvas.height, 1, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();

        // Layer 2: Mid
        ctx.save();
        ctx.translate(-bgMidX % 1000, 0);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 8; j++) {
                ctx.beginPath();
                const x = i * 1000 + (j * 143) % 1000;
                const y = (j * 211) % (canvas.height - 200);
                ctx.arc(x, y, 30 + (j % 3) * 10, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    } else {
        // Legacy background for Phase 2
        ctx.save();
        ctx.translate(-bgScrollX % 800, 0);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        for (let i = 0; i < 20; i++) {
            for (let j = 1; j <= 3; j++) {
                ctx.beginPath();
                ctx.arc(i * 100 + j * 50, (j * 150) % canvas.height, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    // ── World Entities ────────────────────────────────────────────────────────
    // Platforms, Spikes, Crates, Barriers, Goal, Player are already in World Coordinates
    // No extra translate needed since World Transform is active.

    // Platforms
    for (const p of platforms) {
        ctx.save();
        const platColor = gamePhase === 1 ? '#4A5568' : (p.draggable ? '#00FFFF' : '#2C3E50');
        ctx.fillStyle = platColor;
        if (gamePhase === 2 && p.draggable) { ctx.shadowColor = '#00FFFF'; ctx.shadowBlur = 15; }
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(p.x, p.y, p.w, p.h, 6); ctx.fill();
        } else {
            ctx.fillRect(p.x, p.y, p.w, p.h);
        }
        ctx.restore();
    }

    // Spikes
    for (const s of spikes) {
        const isActive = !s.disabledUntil || Date.now() > s.disabledUntil;
        ctx.fillStyle = isActive ? (gamePhase === 1 ? '#A52A2A' : '#FF3366') : '#555';
        ctx.globalAlpha = isActive ? 1.0 : 0.4;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y + s.h); ctx.lineTo(s.x + s.w / 2, s.y); ctx.lineTo(s.x + s.w, s.y + s.h);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }

    // Particles
    for (let p of particles) {
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        if (p.type === 'bubble') {
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size || 2, 0, Math.PI * 2); ctx.fill();
        } else {
            const s = p.size || 4; ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        }
    }
    ctx.globalAlpha = 1;

    // Barriers
    for (const b of barriers) {
        const now = Date.now();
        const fadeTime = 300, totalDur = 3300;
        const elapsed = b.disabledUntil ? now - (b.disabledUntil - totalDur) : Infinity;
        let alpha = 1.0;
        if (elapsed < fadeTime) alpha = 1.0 - (elapsed / fadeTime);
        else if (elapsed < totalDur - fadeTime) alpha = 0.0;
        else if (elapsed < totalDur) alpha = (elapsed - (totalDur - fadeTime)) / fadeTime;
        if (alpha < 0.01) continue;
        ctx.save();
        ctx.globalAlpha = alpha; ctx.shadowColor = '#FF00FF'; ctx.shadowBlur = 25; ctx.fillStyle = '#FF00FF';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'; ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
            const h = (b.h / 4) * i;
            ctx.beginPath(); ctx.moveTo(b.x, b.y + h); ctx.lineTo(b.x + b.w, b.y + h); ctx.stroke();
        }
        ctx.restore();
    }

    // Crates
    for (const c of crates) {
        ctx.save();
        ctx.shadowColor = '#E67E22'; ctx.shadowBlur = 10; ctx.fillStyle = '#E67E22';
        ctx.fillRect(c.x, c.y, c.w, c.h);
        ctx.strokeStyle = '#D35400'; ctx.lineWidth = 2;
        ctx.strokeRect(c.x + 4, c.y + 4, c.w - 8, c.h - 8);
        ctx.beginPath();
        ctx.moveTo(c.x + 4, c.y + 4); ctx.lineTo(c.x + c.w - 4, c.y + c.h - 4);
        ctx.moveTo(c.x + c.w - 4, c.y + 4); ctx.lineTo(c.x + 4, c.y + c.h - 4);
        ctx.stroke();
        ctx.restore();
    }

    // Goal Door
    if (goalDoor) {
        ctx.fillStyle = goalDoor.color; ctx.fillRect(goalDoor.x, goalDoor.y, goalDoor.w, goalDoor.h);
        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(goalDoor.x + 10, goalDoor.y + goalDoor.h / 2, 10, 10);
    }

    // Player
    const px = gamePhase === 1 ? worldX + player.x : player.x;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(px + player.w / 2, player.y + player.h + 2, 12, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.save();
    const pColor = gamePhase === 1 ? '#F1C40F' : '#FF3366'; // Yellow for Phase 1 to pop against cyan background
    ctx.shadowColor = pColor; ctx.shadowBlur = gamePhase === 1 ? 5 : 20; ctx.fillStyle = pColor;
    if (ctx.roundRect) {
        ctx.beginPath(); ctx.roundRect(px, player.y, player.w, player.h, 8); ctx.fill();
    } else {
        ctx.fillRect(px, player.y, player.w, player.h);
    }
    ctx.restore();

    // Eye state detection
    let isDead = isDying || gameOver;
    let inTension = false;
    const playerWorldX = gamePhase === 1 ? worldX + player.x : player.x;

    if (!isDead) {
        const searchRangeX = 140;
        // Check spikes
        for (const s of spikes) {
            const isActive = !s.disabledUntil || Date.now() > s.disabledUntil;
            if (isActive && s.x > playerWorldX && s.x < playerWorldX + searchRangeX) {
                inTension = true; break;
            }
        }
        // Check gap ahead
        if (!inTension && player.grounded && player.currentPlatform) {
            if (player.currentPlatform.x + player.currentPlatform.w < playerWorldX + searchRangeX) {
                inTension = true;
            }
        }
    }

    // Eyes
    if (isDead) {
        ctx.strokeStyle = '#111'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.beginPath();
        ctx.moveTo(px + 6, player.y + 10); ctx.lineTo(px + 12, player.y + 14);
        ctx.moveTo(px + 12, player.y + 10); ctx.lineTo(px + 6, player.y + 14);
        ctx.moveTo(px + 18, player.y + 10); ctx.lineTo(px + 24, player.y + 14);
        ctx.moveTo(px + 24, player.y + 10); ctx.lineTo(px + 18, player.y + 14);
        ctx.stroke();
    } else if (inTension) { // Wide eyes
        ctx.fillStyle = 'white'; ctx.beginPath();
        ctx.arc(px + 9, player.y + 12, 5.5, 0, Math.PI * 2); ctx.arc(px + 21, player.y + 12, 5.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#111'; ctx.beginPath();
        ctx.arc(px + 9, player.y + 12, 1.2, 0, Math.PI * 2); ctx.arc(px + 21, player.y + 12, 1.2, 0, Math.PI * 2); ctx.fill();
    } else { // Normal
        ctx.fillStyle = 'white'; ctx.beginPath();
        ctx.arc(px + 9, player.y + 12, 4.5, 0, Math.PI * 2); ctx.arc(px + 21, player.y + 12, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#111'; ctx.beginPath();
        ctx.arc(px + 9, player.y + 12, 2.5, 0, Math.PI * 2); ctx.arc(px + 21, player.y + 12, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore(); // end world transform

    // ── Overlay / HUD ─────────────────────────────────────────────────────────
    if (victory) {
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#f1c40f';
        ctx.font = 'bold 50px Outfit'; ctx.textAlign = 'center';
        ctx.fillText('CELEBRATION!', canvas.width / 2, canvas.height / 2);
        ctx.font = '20px Outfit';
        ctx.fillText('Level Complete. Click to restart.', canvas.width / 2, canvas.height / 2 + 50);
    }

    if (gamePhase === 2 && !victory) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '400 14px Poppins'; ctx.textAlign = 'left';
        ctx.fillText('CONTROL: DRAG/ROTATE PLATFORMS • CLICK SPIKES', 20, 80);
    }

    // ── HUD (Timer & Phase) ──────────────────────────────────────────────────

    // HUD Bar background
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, canvas.width, 50);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.moveTo(0, 50); ctx.lineTo(canvas.width, 50); ctx.stroke();

    ctx.font = '600 18px Poppins';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'left';
    ctx.shadowBlur = 4; ctx.shadowColor = 'black';

    // Timer
    const elapsedTotal = Math.floor((Date.now() - phaseStartTime) / 1000);
    ctx.fillText(`TIME: ${elapsedTotal}s`, 30, 32);

    // Phase Indicator
    ctx.textAlign = 'right';
    const phaseStr = gamePhase === 1 ? 'PHASE 1: RUN' : 'PHASE 2: CONTROL';
    ctx.fillStyle = gamePhase === 1 ? '#4facfe' : '#f1c40f';
    ctx.fillText(phaseStr, canvas.width - 30, 32);

    // State Messages (GameOver / Victory)
    ctx.textAlign = 'center';

    // Vignette Effect for Phase 2
    if (gamePhase === 2) {
        const vig = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 100, canvas.width / 2, canvas.height / 2, canvas.width * 0.8);
        vig.addColorStop(0, 'rgba(0,0,0,0)');
        vig.addColorStop(1, 'rgba(0,0,0,0.4)');
        ctx.save();
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
    }
    if (gameOver) {
        ctx.shadowBlur = 20; ctx.shadowColor = 'rgba(255,50,50,0.5)';
        ctx.fillStyle = '#FF4B5C';
        ctx.font = '700 64px Poppins';
        ctx.fillText("GAME OVER", canvas.width / 2, canvas.height / 2);
        ctx.font = '400 20px Poppins'; ctx.fillStyle = 'white';
        ctx.fillText("Returning to Phase 1...", canvas.width / 2, canvas.height / 2 + 50);
    }

    if (victory) {
        ctx.shadowBlur = 20; ctx.shadowColor = 'rgba(241,196,15,0.5)';
        ctx.fillStyle = '#f1c40f';
        ctx.font = '700 64px Poppins';
        ctx.fillText("LEVEL COMPLETE", canvas.width / 2, canvas.height / 2);
    }

    ctx.shadowBlur = 0;

    // Radial Flashes
    for (let f of radialFlashes) {
        ctx.save();
        ctx.globalAlpha = f.life * 0.5;
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(f.x - cameraX, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // Interaction Cooldown UI
    const nowCo = Date.now();
    if (nowCo < interactionCooldownEnd) {
        ctx.save();
        const pct = (interactionCooldownEnd - nowCo) / INTERACTION_COOLDOWN_MS;
        ctx.beginPath();
        ctx.arc(screenMouseX, screenMouseY, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
    }
}

// =============================================================================
//  TRANSITION / LOOP
// =============================================================================

function drawTransition(elapsed) {
    draw();

    if (elapsed < 600) {
        const a = elapsed < 100 ? elapsed / 100 : 1 - (elapsed - 100) / 500;
        ctx.fillStyle = `rgba(255,255,255,${Math.max(0, a).toFixed(3)})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (elapsed >= 400) {
        const ta = Math.min(1, (elapsed - 400) / 300);
        ctx.fillStyle = `rgba(0,0,0,${(ta * 0.8).toFixed(3)})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.globalAlpha = ta; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = '#FF3366'; ctx.shadowBlur = 40;
        ctx.font = '700 48px Poppins';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('You were never in control.', canvas.width / 2, canvas.height / 2);
        ctx.restore();
    }
}

function loop() {
    const now = Date.now();

    if (gamePhase === 1 && now - phaseStartTime >= PHASE_1_DURATION_MS) {
        gamePhase = 2; // technical switch
        transitioning = true;
        transitionStartTime = now;
    }

    if (transitioning) {
        const elapsed = now - transitionStartTime;
        if (elapsed >= TRANSITION_DURATION) {
            transitioning = false;
            init(); // setup Phase 2 world
        }
        drawTransition(elapsed);
    } else {
        update();
        draw();
    }

    requestAnimationFrame(loop);
}

// =============================================================================
//  BOOTSTRAP
// =============================================================================
init();
loop();
