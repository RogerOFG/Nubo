// The island: DOM shell, sizing animation, Nubo placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { currentLyrics, currentLyricWindow, lyricsEnabled, lyricsLoading, lyricsView, setLyricsBack, type LyricLine } from "../core/lyrics";
import { Bridge, IS_TAURI, onDragDrop, type DragDropPayload } from "../core/bridge";
import {
  CLOSED_BOT_D, CLOSED_H, closedContent, closedIsland, closedWidth, type ClosedContent,
} from "../core/closed";
import {
  COMPACT_W, EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  QUESTION_PICKER_H,
  type BotEmoteName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { dockRect, lateralEdge, type IslandEdge } from "../core/dock";
import { HOST_OS } from "../core/pills";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { hasPendingReminders } from "../core/todos";
import { SPOTIFY_ID, Spotify, isAd, islandDances } from "../core/spotify";
import { BOT_STATES, BotEngine, hexToRGB } from "../nubo/engine";
import { Greeting } from "../nubo/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../nubo/minibots";
import { SeasonCache, parseOutfit } from "../nubo/wardrobe";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq, uploadProgressCurve } from "../upload/sequence";
import { dominantPct } from "../core/plan";
import { language, t, tl } from "../i18n/i18n";
import { CLAUDE_PLAN_COLOR, claudeCompactPillVisible, claudePillVisible, closePlanCard, codexPillVisible, openPlanColor, planCardOpen } from "../views/usage";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { buildSessionDropList, type SessionDropList } from "../views/session-drop";
import { DROP_TEXT_RIGHT_WITH_LIST, dropTargetAt, dropTargets } from "../core/launch";
import { IslandStateMachine } from "./fsm";
import { refreshHookPills } from "./integrations";
import { RESPONSE_ALERT_SECONDS, restoreAlertFocus } from "./hooks";
import { DesktopLink } from "./desktop";
import type { ViewCommand } from "./shortcuts";
import { DRAG_THRESHOLD } from "../nubo/desktop-logic";
import { Updates } from "./update";
import { UPDATE_BLUE, showsUpdateHint } from "../whats-new/whats-new";

const BOT_OVERHANG = 40;
const UPDATE_BLUE_RGB = hexToRGB(UPDATE_BLUE);
const CLAUDE_DESKTOP_ID = "agent_claude-desktop";
/** Extra canvas on each side of Nubo, for the witch hat's brim and the Santa hat's tip. */
const BOT_SIDE = 24;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The views with a text field: the island takes the keyboard while one is on. */
const TYPING_VIEWS: ReadonlySet<IslandViewName> = new Set(["prompt", "launch"]);

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

/** The tab views in the header's order: what a sideways swipe moves through. */
const TAB_ORDER: readonly IslandViewName[] = ["overview", "prompt", "upload", "snippets", "tasks", "launch"];

/** Where a view sits in the tabs (the empty home is the first); -1 for any other view. */
function tabIndex(view: IslandViewName): number {
  return TAB_ORDER.indexOf(view === "empty" ? "overview" : view);
}

/** The compact island when nothing sits in its middle (Nubo, the plan gauge, the mini bots). */
const SLIM_COMPACT_W = 240;
const SIDE_COMPACT_W = 50;
const SIDE_COMPACT_H = 126;
const HORIZONTAL_GRIP_SPACE = 16;
const SIDE_PANEL_W = 372;
const SIDE_PANEL_H = 650;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();
  /** Nubo on the desktop: his life cycle and the drag out of the island. */
  readonly desktop: DesktopLink;

  private root: HTMLElement;
  private dockEdge: IslandEdge = "top";
  private dockAnchor: number | null = null;
  private dockMoving = false;
  private dockMoveId = 0;
  private dockClickToOpen = false;
  private foldedLyricsOnDock = false;
  private dockGrip!: HTMLButtonElement;
  private dockPreview: [IslandEdge, number] | null = null;
  private dockWasMoved = false;
  private sidePin!: HTMLButtonElement;
  private sideLyricsEl!: HTMLElement;
  private sideLyricTrack!: HTMLElement;
  private sideLyricEmpty!: HTMLElement;
  private sideLyricSource: readonly LyricLine[] | null = null;
  private sideLyricIndex = -2;
  private resumeLyrics = false;
  private pinnedLyrics = false;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private clockEl!: HTMLElement;
  private clockTimer?: number;
  private lyricEl!: HTMLElement;
  private lyricSpan!: HTMLElement;
  private lyricProbe!: HTMLElement;
  private lyricTimer?: number;
  /** The closed island's one line (core/closed.ts), and what it last showed. */
  private closedEl!: HTMLElement;
  private reminderDot!: HTMLElement;
  private showingPendingTasks = false;
  private closedDot!: HTMLElement;
  private closedText!: HTMLElement;
  private closedKey = "";
  /** Width of the closed island for what it shows now. */
  private closedW = 120;
  /** Nubo's little life in the closed island: where he looks, and until when
   *  the loop runs for what he is doing (a blink, a glance). */
  private closedLook = { x: 0, y: 0 };
  private closedAwakeUntil = 0;
  private closedLife: number | null = null;
  /** The size the window was last folded to, so a new one is only sent on a change. */
  private collapsedTo = { w: 0, h: 0 };
  private countdown!: HTMLElement;
  private compactPlan!: HTMLElement;
  private compactPlanDot!: HTMLElement;
  private compactPlanLabel!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;
  /** The sessions listed on the drop card while a file is over it. */
  private sessionDrop!: SessionDropList;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();
  private greetingShown = false;
  private seasons = new SeasonCache();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;
  /** The pixel ratio Nubo's bitmap was sized for: it changes with the monitor. */
  private canvasDpr = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** A reply is being typed in a card (WhatsApp): the island stays open. */
  private holdingOpen = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** The launch greeting ended, or the island came out of hidden — two of the
   *  moments the Monday recap may open (see src/recap/recap.ts). */
  onGreetingDone: (() => void) | null = null;
  onWake: (() => void) | null = null;

  /** Where a press on Nubo started: moving past DRAG_THRESHOLD drags him out. */
  private botPress: { x: number; y: number } | null = null;

  /** The next reveal from hidden makes no peek (music starting, as on macOS). */
  private silentReveal = false;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;
  private dragLeaveTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.desktop = new DesktopLink({
      reveal: () => this.reveal(),
      wardrobeFromDesktop: () => this.wardrobeFromDesktop(),
      dizzyFromDesktop: () => this.handleDizzy(),
    });
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    // Lyrics showing: the compact island stays (see IslandStateMachine.keepCompact).
    this.fsm.keepCompact = () => this.dockMoving || this.sideLyricsCompact() || hasPendingReminders()
      || (State.spotifyPlaying && lyricsEnabled());
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  /** The request has its answer: the card goes and the session carries on. */
  private closeApproval() {
    State.endApproval();
    if (State.pendingApproval) {
      const view = State.pendingApproval.questions ? "question" : "approval";
      this.setView(view);
      Sound.play(view);
      return;
    }
    if (this.restorePinnedLyrics()) return;
    this.fsm.pinned = false;
    this.setView(State.defaultView());
  }

  /**
   * Folds a card that is waiting for an answer down to the compact island,
   * without answering it (Mac #290). Nothing is decided: the request keeps
   * waiting, the island stays on screen, and opening it shows the card again.
   */
  foldApproval() {
    if (!State.pendingApproval || State.mode !== "expanded") return;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.forcePetit();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      foldApproval: () => this.foldApproval(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A pill with a waiting request opens on its card: going back to it
        // after looking at another pill brings the card up again.
        const req = State.pendingApproval;
        if (req?.pillId === id) this.setView(req.questions ? "question" : "approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        // Sessions from the Claude desktop app live there, not in a terminal.
        if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task?.id === "agent_codex") void Bridge.openCodexDesktop(task.sessionId ?? null);
        else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null, task?.name ?? null);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com/pulls",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task.id === "agent_codex") void Bridge.openCodexDesktop(task.sessionId ?? null);
        else if (task.id === "integration_claude" || task.sessionId) {
          void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null, task.name);
        } else if (task.id === "integration_n8n") void Bridge.openN8n();
        // WhatsApp Desktop at the open conversation; WhatsApp Web when it isn't installed.
        else if (task.id === "integration_whatsapp") void Bridge.whatsappOpenApp();
        else if (task.id === "integration_gitea") void Bridge.openGitea();
        else if (task.id === SPOTIFY_ID) void Bridge.spotifyOpen();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        this.closeApproval();
      },
      answer: (answers) => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.closeApproval();
      },
      answerInTerminal: () => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecline(req.requestId);
        this.closeApproval();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      chooseOutfit: (selection) => {
        if (parseOutfit(State.settings.nuboOutfit) === selection) return;
        State.settings.nuboOutfit = selection;
        void Bridge.saveSettings(State.settings);
        Sound.play("pop");
        this.engine.triggerEmote("proud");
        State.notify();
      },
      previewOutfit: (outfit) => {
        State.wardrobePreview = outfit;
        State.notify();
      },
      keyboard: (on) => {
        // The chat and launch views manage the keyboard on their own.
        if (on) void Bridge.focusWindow(true);
        else if (!TYPING_VIEWS.has(State.view) && State.mode === "expanded") void Bridge.focusWindow(false);
      },
      launched: () => {
        Sound.play("send");
        this.engine.triggerEmote("happy");
        this.collapse();
      },
      holdOpen: (on) => {
        if (this.holdingOpen === on) return;
        this.holdingOpen = on;
        if (on) {
          this.fsm.pinned = true;
          this.fsm.cancelTimers();
        } else {
          this.fsm.pinned = State.isPinned || State.pendingApproval != null;
          if (!this.fsm.pinned && !this.wasInIsland && this.fsm.state === "home") this.fsm.mouseLeft();
        }
      },
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.closedDot = h("span", { class: "dot" });
    this.reminderDot = h("span", { id: "task-reminder-dot", "aria-hidden": "true", hidden: true });
    this.closedText = h("span", { class: "text" });
    this.closedEl = h("div", { id: "island-closed" }, this.closedDot, this.closedText);
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.clockEl = h("div", { id: "island-clock" });
    this.lyricSpan = h("span", { class: "t" });
    this.lyricEl = h("div", { id: "island-lyric" }, this.lyricSpan);
    this.lyricProbe = h("span", { id: "island-lyric-probe" });
    this.countdown = h("div", { id: "countdown" });
    this.dockGrip = h("button", { id: "dock-grip", title: tl("Move island"), hidden: true });
    this.compactPlanDot = h("i", { class: "compact-plan-dot" });
    this.compactPlanLabel = h("span", { class: "compact-plan-label" });
    this.compactPlan = h(
      "button",
      {
        id: "compact-plan",
        title: tl("Claude plan usage"),
        onmousedown: (e) => {
          e.stopPropagation();
        },
        onclick: (e) => {
          e.stopPropagation();
          const me = e as MouseEvent;
          if (me.button === 0) this.openClaudePlan();
        },
      },
      this.compactPlanDot,
      this.compactPlanLabel,
    );

    this.sidePin = h("button", { id: "side-lyrics-pin", hidden: true, text: tl("Pin lyrics"),
      onclick: () => this.toggleLyricsPin() });
    this.sideLyricTrack = h("div", { class: "side-lyrics-track" });
    this.sideLyricEmpty = h("p", { class: "side-lyrics-empty" });
    this.sideLyricsEl = h("div", { id: "side-lyrics-only", hidden: true }, this.sideLyricTrack, this.sideLyricEmpty);
    new ResizeObserver(() => {
      if (!this.sideLyricsEl.hidden) this.paintSideLyrics();
    }).observe(this.sideLyricsEl);
    this.header = buildHeader(actions);
    this.header.el.querySelector(".header-actions")?.prepend(this.sidePin);
    this.header.el.append(this.dockGrip);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);
    const measure = new ResizeObserver(() => this.syncPanelSize());
    measure.observe(this.header.el);
    for (const name of ["overview", "upload", "snippets"] as const) {
      for (const child of this.views.get(name)?.el.children ?? []) measure.observe(child);
    }

    // The drop sequence draws the card, the bar and its own Nubo. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas();
    this.sessionDrop = buildSessionDropList();
    this.uploadCanvas.el.append(this.sessionDrop.el);

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.compactPlan,
      this.clockEl,
      this.lyricEl,
      this.sideLyricsEl,
      this.lyricProbe,
      this.closedEl,
      this.reminderDot,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    this.fsm.keepHomeOpen = () => this.dockMoving || State.view === "tasks" && hasPendingReminders();
    this.fsm.alertHomeDelay = () => State.view === "finished" || State.view === "error"
      ? RESPONSE_ALERT_SECONDS : null;
    this.fsm.onTransition = (from, to) => {
      // The greeting is over, however it ended: back to his desktop spot.
      if (from === "nubo" && to !== "nubo") this.desktop.launch();
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "nubo") this.greeting.interrupt();
          else if (from === "hidden" && !this.silentReveal) Sound.play("peek");
          this.setMode("compact");
          this.restorePinnedLyrics();
          if (from === "nubo") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(this.openingView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          // Hooks may have been installed in a terminal since: the idle cards
          // say so on the next open, without polling while the island is shut.
          void refreshHookPills();
          break;
        case "nubo":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      // A folded card is still waiting: it keeps the island pinned.
      if (!State.pendingApproval) State.isPinned = false;
      void Bridge.focusWindow(false);
      // Another pill's alert borrowed the front: the pill you had comes back (Mac).
      restoreAlertFocus();
    }
    if (mode !== "expanded") {
      closePlanCard();
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    // Folding all the way: the closed island's width for what it will show.
    if (mode === "hidden") this.updateClosed();
    else this.closedEl.classList.remove("on");
    this.scheduleClosedLife();
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) {
      UploadSeq.deactivate();
      this.releaseDropPin();
    }
  }

  /** Click on compact plan gauge: opens the Claude plan card on the overview. */
  openClaudePlan() {
    Sound.resume();
    State.lastActivity = performance.now();
    this.fsm.userInteracted();
    State.planDetailIsCodex = false;
    State.showingPlanDetail = true;
    this.fsm.forceHome();
    this.expand("overview");
    State.notify();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    if (["approval", "question", "finished", "error", "tasks"].includes(view)) {
      this.interruptDockMove();
      if (this.pinnedLyrics && (view !== "tasks" || hasPendingReminders())) this.resumeLyrics = true;
    } else if (view === "overview" && this.restorePinnedLyrics()) {
      return;
    } else if (view !== "overview") {
      this.pinnedLyrics = false;
      this.resumeLyrics = false;
    }
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const wasTimedAlert = this.fsm.alertHomeDelay() != null || this.fsm.keepHomeOpen();
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    if (!this.wasInIsland && (wasTimedAlert || this.fsm.alertHomeDelay() != null)) this.fsm.mouseLeft();
    State.notify();
  }

  collapse() {
    if (this.restorePinnedLyrics()) return;
    // A waiting card is only ever folded, never dropped by a close.
    if (State.pendingApproval) {
      this.foldApproval();
      return;
    }
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.interruptDockMove();
    if (this.pinnedLyrics && (State.focusTask?.id !== SPOTIFY_ID ||
        ["approval", "question", "tasks", "finished", "error"].includes(view))) {
      this.resumeLyrics = true;
    }
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
    if (this.fsm.alertHomeDelay() != null && !this.wasInIsland) this.fsm.mouseLeft();
  }

  /** A new Nubo waits and Nubo has nothing else to say (he is blue). */
  private updateHintOn(): boolean {
    return !State.paused && showsUpdateHint(Updates.waiting(), State.effectiveState, State.pendingApproval != null);
  }

  /**
   * What a click or a hover opens on: while Nubo is blue, the new version
   * ("Nubo X is out", Update now); otherwise the usual view. A waiting
   * permission or question always comes first.
   */
  private openingView(): IslandViewName {
    if (!State.pendingApproval && hasPendingReminders()) return "tasks";
    return this.updateHintOn() ? "update" : State.defaultView();
  }

  reveal() {
    this.fsm.reveal();
  }

  /** Music started playing: the compact island, without the peek sound (musicReveal). */
  revealSilently() {
    this.silentReveal = true;
    this.fsm.reveal();
    this.silentReveal = false;
  }

  /** Right-click on Nubo: wardrobe open ↔ back to the usual view. */
  toggleWardrobe() {
    if (State.paused || State.mode === "hidden") return;
    // The greeting and the drop sequence draw a Nubo of their own.
    if (State.mode === "expanded" && (State.view === "greeting" || this.uploadActive)) return;
    if (State.mode === "expanded" && State.view === "wardrobe") this.setView(State.defaultView());
    else this.setView("wardrobe");
  }

  /**
   * Right-click on the desktop Nubo (macOS openWardrobeFromDesktop): opens the
   * wardrobe from any state, or goes back if it is already open.
   */
  wardrobeFromDesktop() {
    this.wardrobeAnywhere();
  }

  /**
   * The wardrobe from any state — compact or hidden island included — or back
   * to the usual view if it is already open. The desktop Nubo's right-click
   * and the wardrobe shortcut (`open-wardrobe`) both land here.
   */
  wardrobeAnywhere() {
    if (State.mode === "expanded" && State.view === "wardrobe") {
      this.setView(State.defaultView());
      return;
    }
    if (State.paused) return;
    this.alert("wardrobe");
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
    // The countdown the pin held back starts now, if the mouse is elsewhere.
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  // ── Keyboard shortcuts (island/shortcuts.ts) ────────────────────────────────

  emote(name: BotEmoteName) {
    this.engine.triggerEmote(name);
    this.ensureRunning();
  }

  /** Ctrl+P: keep the open island from folding away, or let it fold again. */
  setPinned(on: boolean) {
    State.isPinned = on;
    this.fsm.pinned = on;
    if (on) {
      // The countdown bar reads the state machine's deadline, cleared with it.
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  /** The island takes the keyboard, so its own shortcuts work (Mac: makeKey).
   *  It gives it back when it closes, or when the chat is left. */
  takeKeyboard() {
    void Bridge.focusWindow(true);
  }

  /** The desktop shortcut needs a desktop Nubo: none on GNOME's Wayland. */
  canLeaveIsland(): boolean {
    return this.desktop.supported;
  }

  /** The desktop shortcut (macOS DesktopNuboController.flyOutOrHome). */
  flyOutOrHome() {
    // The greeting and the drop sequence draw a Nubo of their own: he stays
    // for them, as he does for a drag (canDragOut).
    const busy = State.mode === "expanded" && (State.view === "greeting" || this.uploadActive);
    if (busy && !State.nuboOnDesktop) return;
    this.desktop.flyOutOrHome();
  }

  /** Ctrl+O / Ctrl+E go to the view on screen. */
  viewCommand(command: ViewCommand) {
    this.views.get(State.view)?.command?.(command);
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: DragDropPayload) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused || State.shelfDragging || this.dockMoving || State.pendingApproval) return;
    if (this.dragLeaveTimer != null && e.type !== "leave") {
      window.clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }
    // Tauri's own drag events say where the pointer is (Linux, where the page
    // hears no mouse during a drag); Windows has the cursor poll (onCursor).
    if (e.position && e.type !== "leave") {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.islandRect();
      this.updateDropTarget(e.position.x / dpr - rect.x, e.position.y / dpr - rect.y);
    }
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        if (!this.lateral) UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        State.dropSessionTarget = null;
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island stays open briefly for recovery, but auto-exits upload mode
        // if the drop occurred outside or the drag was aborted.
        UploadSeq.exitZone();
        State.notify();
        if (this.dragLeaveTimer != null) window.clearTimeout(this.dragLeaveTimer);
        this.dragLeaveTimer = window.setTimeout(() => {
          this.dragLeaveTimer = null;
          if (!State.fileDragOver && State.view === "upload") {
            this.engine.animateMorph(0);
            this.setView(State.defaultView());
            if (!this.wasInIsland) {
              this.fsm.mouseLeft();
            }
          }
        }, 800);
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        // Let go over one of the sessions on the drop card: into its prompt.
        const target = State.dropSessionTarget;
        State.dropSessionTarget = null;
        if (target && e.paths?.length) {
          this.dropIntoSession(target, e.paths);
          return;
        }
        const paths = e.paths;
        if (!paths?.length) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(paths);
        break;
      }
    }
  }

  /** The session pill under the pointer on the drop card (island points), if any. */
  private updateDropTarget(x: number, y: number) {
    const targets = State.view === "upload" && State.fileDragOver && !UploadSeq.dropped ? dropTargets(State.tasks) : [];
    if (this.lateral && targets.length > 0) {
      const rect = this.islandRect();
      State.dropSessionTarget = this.sessionDrop.targetAt(x + rect.x, y + rect.y);
      return;
    }
    const i = targets.length > 0 ? dropTargetAt(x, y, targets.length) : null;
    State.dropSessionTarget = i == null ? null : targets[i].id;
  }

  /**
   * A file let go over a session on the drop card (SessionDrop.send): the
   * island folds, Rust brings the session's window forward and pastes the
   * paths there. When it can only copy them, a note says so.
   */
  private dropIntoSession(taskId: string, paths: string[]) {
    const task = State.tasks.find((x) => x.id === taskId);
    UploadSeq.deactivate();
    this.engine.animateMorph(0);
    this.setView(State.defaultView());
    this.collapse();
    if (!task?.sessionId) return;
    void Bridge.log(`drop: ${paths.length} file(s) into ${task.name}`);
    void Bridge.dropIntoSession(task.sessionId, task.sessionCwd ?? null, paths).then((outcome) => {
      if (outcome === "pasted") {
        Sound.play("send");
        this.engine.triggerEmote("happy");
        return;
      }
      Sound.play("error");
      if (outcome !== "copied") return;
      State.noteMessage = t("Copied: paste it into the session's terminal.");
      this.alert("note");
      window.setTimeout(() => {
        if (State.mode === "expanded" && State.view === "note") this.collapse();
      }, 4000);
    });
  }

  /**
   * Nubo eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(paths: string[]) {
    const entries = paths.map((path) => ({
      name: path.split(/[\\/]/).pop() || "file",
      path,
      ready: false,
    }));
    State.shelfError = "";
    State.shelfFiles.push(...entries);
    State.droppedFile = entries[0];

    if (this.lateral) {
      this.engine.animateMorph(0);
      this.setView("upload");
      Sound.play("approve");
      void this.ingestShelfFiles(entries);
      return;
    }
    if (!UploadSeq.isActive || UploadSeq.dropped) {
      UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
    }
    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;
    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.fsm.pinned = true;
    this.fsm.cancelTimers();
    this.setView("uploading");
    this.ensureRunning();
    this.watchSequence();
    void this.ingestShelfFiles(entries);
  }

  private async ingestShelfFiles(entries: typeof State.shelfFiles) {
    for (const entry of entries) {
      try {
        const file = await Bridge.ingestFile(entry.path);
        if (!State.shelfFiles.includes(entry)) continue;
        entry.path = file.path;
        entry.name = file.name;
        entry.ready = true;
      } catch (err) {
        if (!State.shelfFiles.includes(entry)) continue;
        State.shelfFiles = State.shelfFiles.filter((file) => file !== entry);
        State.shelfError = t("Could not add {name}: {error}", {
          name: entry.name,
          error: String(err).replace(/^Error:\s*/, ""),
        });
        Sound.play("error");
      }
      State.notify();
    }
  }

  private sequenceWatch: number | null = null;

  /**
   * The drop sequence normally advances on animation frames, but a webview that
   * is throttled right after a drop (the drag came from another app) delivers
   * none: the bar sat at 0 % and the island folded on its timer. This timer
   * advances the same sequence regardless of frames.
   */
  private watchSequence() {
    if (this.sequenceWatch != null) window.clearInterval(this.sequenceWatch);
    this.sequenceWatch = window.setInterval(() => {
      const waiting = UploadSeq.isActive && UploadSeq.dropped && State.view === "uploading";
      if (!waiting) {
        if (this.sequenceWatch != null) window.clearInterval(this.sequenceWatch);
        this.sequenceWatch = null;
        return;
      }
      this.stepSequence();
    }, 100);
  }

  /** Lets the island fold again after the drop flow (unless something else pins it). */
  private releaseDropPin() {
    this.fsm.pinned = State.isPinned || State.pendingApproval != null || this.holdingOpen;
    if (!this.fsm.pinned && !this.wasInIsland && this.fsm.state === "home") this.fsm.mouseLeft();
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then the shelf once Nubo has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    // The bar and the percentage follow the same eased curve as Nubo.
    State.uploadProgress = uploadProgressCurve(p);
    if (State.view === "uploading") this.views.get("uploading")?.sync();

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, before the shelf is visible.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      UploadSeq.deactivate();
      this.setView("upload");
      this.releaseDropPin();
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  /** The closed island stays on screen (anything but "hidden"). */
  private get closedShows(): boolean {
    return closedIsland(State.settings.closedIsland) !== "hidden";
  }

  private get lateral(): boolean {
    return lateralEdge(this.dockEdge);
  }

  private sideLyricsShowing(): boolean {
    return this.lateral && State.mode === "expanded" && State.view === "overview"
      && State.focusTask?.id === SPOTIFY_ID && !planCardOpen() && this.hasLyricsTrack();
  }

  private hasLyricsTrack(): boolean {
    return Spotify.state.track != null && !isAd(Spotify.state.track) && lyricsView();
  }

  get isLyricsPinned(): boolean {
    return this.pinnedLyrics;
  }

  private sideLyricsCompact(): boolean {
    return this.lateral && this.pinnedLyrics && State.mode === "compact" && !State.pendingApproval
      && State.focusTask?.id === SPOTIFY_ID && this.hasLyricsTrack();
  }

  private toggleLyricsPin() {
    if (!this.sideLyricsShowing()) return;
    this.pinnedLyrics = !this.pinnedLyrics;
    this.resumeLyrics = false;
    this.setPinned(false);
  }

  private compactLyrics(): boolean {
    return !this.lateral && State.mode === "compact" && State.spotifyPlaying && lyricsEnabled();
  }

  private restorePinnedLyrics(): boolean {
    if (!this.resumeLyrics || State.pendingApproval || hasPendingReminders()) return false;
    this.resumeLyrics = false;
    if (!this.lateral || !this.pinnedLyrics || !State.tasks.some((task) => task.id === SPOTIFY_ID)) return false;
    State.setFocus(SPOTIFY_ID);
    setLyricsBack(false);
    State.view = "overview";
    this.setPinned(false);
    this.fsm.forcePetit();
    return true;
  }

  private targetSize(): { w: number; h: number; r: number } {
    if (this.lateral) {
      if (State.mode === "hidden") {
        return this.closedShows ? { w: SIDE_COMPACT_W, h: 108, r: 12 } : { w: 0, h: 160, r: 10 };
      }
      if (State.mode === "compact") {
        return this.sideLyricsCompact() ? { w: SIDE_PANEL_W, h: 194, r: EXPANDED_CORNER }
          : { w: SIDE_COMPACT_W, h: (State.otherTasks.length ? SIDE_COMPACT_H : 96) + (State.settings.showClock ? 18 : 0), r: 15 };
      }
      let h = 280;
      if (this.sideLyricsShowing()) h = 416;
      else if (State.view === "overview" || State.view === "upload" || State.view === "snippets") {
        const view = this.views.get(State.view)?.el;
        const children = Array.from(view?.children ?? []) as HTMLElement[];
        const bodyHeight = children.reduce((total, child) => total + child.offsetHeight, 0);
        const gap = State.view === "overview" && children.every((child) => child.offsetHeight > 0) ? 8 : 0;
        const breathingRoom = State.view === "overview" ? 24 : 10;
        h = Math.max(116, Math.min(460, this.viewsEl.offsetTop + bodyHeight + gap + breathingRoom));
      } else if (State.view === "tasks") h = 270;
      else if (State.view === "prompt") h = 510;
      else if (State.view === "greeting") h = 150;
      else if (State.view === "question" || State.view === "recap" || State.view === "whatsNew") h = 420;
      return { w: SIDE_PANEL_W, h: Math.min(SIDE_PANEL_H, h), r: EXPANDED_CORNER };
    }
    if (State.mode === "hidden" && this.closedShows) {
      return { w: this.closedW, h: CLOSED_H, r: 10 };
    }
    let { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    if (State.mode === "expanded" && State.view === "question" && State.pendingApproval?.questions) {
      h = QUESTION_PICKER_H;
    }
    if (State.mode === "expanded" && (claudePillVisible() || codexPillVisible())) h += 12;
    if (State.mode === "compact") {
      // Nothing in the middle (no clock, no lyric): a slimmer island; the
      // usual width stays where the middle is used.
      if (this.lyricW > 0) w = this.lyricW;
      else if (!State.settings.showClock) w = SLIM_COMPACT_W;
      if (HOST_OS === "windows" && !this.compactLyrics()) h += HORIZONTAL_GRIP_SPACE;
    }
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private syncPanelSize() {
    if ((!this.lateral && State.mode !== "expanded") || !this.islandEl || this.dockMoving) return;
    const { w, h } = this.targetSize();
    if (this.width.target !== w || this.height.target !== h) this.animateGeometry(false);
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const rect = this.islandRect();
    const { w, h: hh } = rect;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.left = `${rect.x}px`;
    this.islandEl.style.top = `${rect.y}px`;
    const edge = this.dockWasMoved ? this.dockPreview?.[0] : this.dockEdge;
    const flat = `${r * (1 - (this.dockWasMoved ? this.dockPreview?.[1] ?? 0 : 1))}px`;
    const round = `${r}px`;
    this.islandEl.style.borderRadius = {
      top: `${flat} ${flat} ${round} ${round}`, bottom: `${round} ${round} ${flat} ${flat}`,
      left: `${flat} ${round} ${round} ${flat}`, right: `${round} ${flat} ${flat} ${round}`,
    }[edge ?? "top"];
    this.islandEl.style.transform = "none";
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    // The mini bots sit in a grid of two columns: with one or two of them the
    // grid shrinks to one row (or column) and is centred in the island's height.
    const minis = this.miniGrid.childElementCount;
    const cols = minis >= 2 ? 2 : 1;
    const rows = Math.max(1, Math.ceil(minis / 2));
    const gridW = cols * 13 + (cols - 1) * 3;
    const gridH = rows * 13 + (rows - 1) * 3;
    this.miniGrid.style.width = `${gridW}px`;
    this.miniGrid.style.height = `${gridH}px`;
    const sideGrid = this.lateral && State.mode === "compact";
    this.miniGrid.style.left = `${sideGrid ? (w - gridW) / 2 : w - 40 - 14.5 + (29 - gridW) / 2}px`;
    const compactBodyHeight = !this.lateral && State.mode === "compact" && HOST_OS === "windows" && !this.compactLyrics()
      ? Math.max(0, hh - HORIZONTAL_GRIP_SPACE) : hh;
    const miniCenter = sideGrid ? hh * (State.settings.showClock ? 0.78 : 0.73) : compactBodyHeight / 2;
    this.miniGrid.style.top = `${miniCenter - gridH / 2}px`;
    this.clockEl.style.height = `${compactBodyHeight}px`;
    this.lyricEl.style.height = `${compactBodyHeight}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.y - rect.y) > 0.5 ||
        Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Used by the DOM, Rust's click-through, the bot and file drop. */
  private islandRect() {
    const w = this.width.value;
    const h = this.height.value;
    return dockRect(this.dockEdge, this.dockAnchor, window.innerWidth || PANEL_W, window.innerHeight || PANEL_H, w, h);
  }

  setDockFrame(frame: { edge: IslandEdge; anchor: number }) {
    const changed = this.dockEdge !== frame.edge;
    this.dockEdge = frame.edge;
    this.dockAnchor = frame.anchor;
    this.root.dataset.edge = frame.edge;
    this.root.classList.toggle("dock-lateral", this.lateral);
    if (changed) {
      if (!this.lateral && (this.pinnedLyrics || this.resumeLyrics)) {
        this.pinnedLyrics = false;
        this.resumeLyrics = false;
        if (!State.pendingApproval) {
          if (State.mode === "expanded" && State.view === "overview" && State.focusTask?.id === SPOTIFY_ID) {
            this.foldedLyricsOnDock = this.dockMoving;
            this.collapse();
          } else {
            this.setPinned(false);
          }
        }
      }
      if (this.lateral && this.uploadActive) {
        UploadSeq.deactivate();
        if (State.view === "uploading") this.setView("upload");
        this.releaseDropPin();
      }
      this.updateLyric();
      this.animateGeometry(false);
      if (this.collapsed) this.sendCollapsedSize(true);
      State.notify();
    }
    this.ensureRunning();
  }

  previewDock(preview: [IslandEdge, number] | null) {
    if (!this.dockMoving) return;
    this.dockWasMoved = true;
    this.dockPreview = preview;
    this.ensureRunning();
  }

  finishDockMove(clicked = false) {
    const open = clicked && this.dockClickToOpen && State.mode === "compact";
    const foldedLyrics = this.foldedLyricsOnDock;
    ++this.dockMoveId;
    this.dockClickToOpen = false;
    this.foldedLyricsOnDock = false;
    this.dockMoving = false;
    this.dockWasMoved = false;
    this.dockPreview = null;
    this.root.classList.remove("dock-moving");
    if (open) this.fsm.click();
    if (!this.wasInIsland) this.fsm.mouseLeft();
    else if (!foldedLyrics) this.fsm.mouseEntered();
    this.syncPanelSize();
    this.ensureRunning();
  }

  private interruptDockMove() {
    if (!this.dockMoving) return;
    this.finishDockMove();
    void Bridge.cancelIslandMove();
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish folding, then shrink the window to it — to the
      // closed island, or to the wake strip when that shows nothing: from
      // there nothing polls the cursor at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        this.sendCollapsedSize(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      this.collapsedTo = { w: 0, h: 0 };
      void Bridge.setCollapsed(false);
    }
  }

  /**
   * Nubo in the closed island now and then blinks or glances around, as he
   * does on a Mac without a notch: a few frames every few seconds, the loop
   * asleep in between. Nothing runs for the other closed islands.
   */
  private scheduleClosedLife() {
    if (this.closedLife != null) window.clearTimeout(this.closedLife);
    this.closedLife = null;
    if (State.mode !== "hidden" || closedIsland(State.settings.closedIsland) !== "nubo") {
      this.closedLook = { x: 0, y: 0 };
      return;
    }
    this.closedLife = window.setTimeout(() => {
      this.closedLife = null;
      if (State.mode !== "hidden" || State.paused) return this.scheduleClosedLife();
      if (Math.random() < 0.55) {
        this.engine.blink();
      } else {
        this.closedLook = { x: (Math.random() * 2 - 1) * 0.8, y: (Math.random() * 2 - 1) * 0.3 };
      }
      this.closedAwakeUntil = performance.now() + 700;
      this.ensureRunning();
      this.scheduleClosedLife();
    }, 2500 + Math.random() * 3500);
  }

  /** The pointer is on the folded window (Rust's `closed-hover`): the island wakes. */
  wakeFromClosed() {
    if (State.mode !== "hidden") return;
    Sound.resume();
    this.fsm.mouseEntered();
  }

  /** Tells Rust the folded window's size: the closed island's, or none (the strip). */
  private sendCollapsedSize(force = false) {
    const size = this.lateral
      ? this.closedShows ? { w: SIDE_COMPACT_W, h: 108 } : { w: 6, h: 160 }
      : this.closedShows ? { w: this.closedW, h: CLOSED_H } : { w: 0, h: 0 };
    if (!force && size.w === this.collapsedTo.w && size.h === this.collapsedTo.h) return;
    this.collapsedTo = size;
    if (size.w > 0) void Bridge.setCollapsed(true, size.w, size.h);
    else void Bridge.setCollapsed(true);
  }

  /**
   * What the closed island shows, redrawn when it changes (the minute, the
   * song, the plan): a new width animates the island and, once folded,
   * resizes the window to it.
   */
  private updateClosed() {
    const style = closedIsland(State.settings.closedIsland);
    const track = Spotify.state.track;
    const content: ClosedContent | null = State.mode === "hidden" || this.collapsed
      ? closedContent(style, {
        now: new Date(),
        locale: language(),
        planUsage: State.planUsage,
        music: State.spotifyPlaying && track ? { title: track.title, artist: track.artist } : null,
      })
      : null;
    const key = content ? `${style}|${content.text}|${content.dot ?? ""}|${content.note}` : style;
    const shown = State.mode === "hidden" && this.closedShows;
    this.closedEl.classList.toggle("on", shown && content != null);
    if (key === this.closedKey) return;
    this.closedKey = key;
    this.closedText.textContent = content?.text ?? "";
    this.closedEl.classList.toggle("note", content?.note === true);
    this.closedDot.style.display = content?.dot ? "" : "none";
    if (content?.dot) this.closedDot.style.background = content.dot;
    // Measured as drawn: the font and the language decide the width.
    const extras = (content?.dot ? 12 : 0) + (content?.note ? 16 : 0);
    const w = closedWidth(content ? this.closedText.scrollWidth : 0, extras);
    if (w !== this.closedW) {
      this.closedW = w;
      if (State.mode === "hidden") {
        this.animateGeometry(w < this.width.value);
        if (this.collapsed) this.sendCollapsedSize();
      }
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private beginDockMove(event: MouseEvent, clickToOpen = false) {
    if (event.button !== 0 || this.dockMoving || State.pendingApproval ||
        State.fileDragOver || State.shelfDragging || this.desktop.carrying) return;
    event.preventDefault();
    event.stopPropagation();
    this.dockMoving = true;
    this.dockClickToOpen = clickToOpen;
    this.fsm.cancelTimers();
    this.root.classList.add("dock-moving");
    const id = ++this.dockMoveId;
    void Bridge.beginIslandMove(event.clientX, event.clientY).then((started) => {
      // A touchpad tap may release before the native poll picks up the press.
      if (id === this.dockMoveId && !started) this.finishDockMove(clickToOpen);
    });
  }

  private wireInput() {
    this.dockGrip.addEventListener("mousedown", (event) => {
      this.beginDockMove(event);
    });
    this.dockGrip.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.detail === 0) void Bridge.openSettingsWindow();
    });
    this.dockGrip.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void Bridge.centerIsland(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    });
    window.addEventListener("resize", () => this.ensureRunning());
    // Folded, the window is only the closed island (or the wake strip): the
    // pointer coming onto it is all there is to hear, and it wakes the island.
    const wake = () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    };
    this.wakeStrip.addEventListener("mouseenter", wake);
    this.root.addEventListener("mouseover", () => {
      if (this.collapsed) wake();
    });

    // A two-finger swipe sideways on the touchpad moves between the tabs. One
    // swipe is one step: its inertia, which keeps sending wheel events for a
    // moment, is let go by until the wheel has been quiet for a moment.
    let swipe = 0;
    let swipeDone = false;
    let lastWheel = 0;
    this.islandEl.addEventListener(
      "wheel",
      (e) => {
        if (State.mode !== "expanded") return;
        const i = tabIndex(State.view);
        if (i < 0) return;
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical: the view's own scrolling
        // A text field keeps the swipe only when its own text scrolls sideways;
        // otherwise a field under the pointer (the chat's) would swallow it.
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if ((tag === "INPUT" || tag === "TEXTAREA") && target!.scrollWidth > target!.clientWidth + 1) return;
        e.preventDefault();
        const now = performance.now();
        if (now - lastWheel > 160) {
          swipe = 0;
          swipeDone = false;
        }
        lastWheel = now;
        if (swipeDone) return;
        swipe += e.deltaX;
        if (Math.abs(swipe) < 70) return;
        swipeDone = true;
        // Past the last tab it comes round to the first, and the other way.
        const next = TAB_ORDER[(i + (swipe > 0 ? 1 : -1) + TAB_ORDER.length) % TAB_ORDER.length];
        swipe = 0;
        if (next !== TAB_ORDER[i]) {
          Sound.play("blip");
          State.lastActivity = performance.now();
          this.setView(next);
        }
      },
      { passive: false },
    );

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (HOST_OS === "windows" && e.button === 0 &&
          (this.compactLyrics() || (this.lateral && State.mode === "compact")) && !State.pendingApproval) {
        this.beginDockMove(e, true);
        return;
      }
      // A click makes a hover-opened island an ordinary open one.
      this.fsm.userInteracted();
      // A press on Nubo may become a drag out to the desktop.
      if (e.button === 0 && this.isBotHit(e.clientX, e.clientY)) {
        this.botPress = { x: e.clientX, y: e.clientY };
      }
      // Right-click on Nubo opens the wardrobe, and closes it again.
      if (e.button === 2 && this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.toggleWardrobe();
        return;
      }
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    // No browser menu over Nubo: his right-click is the wardrobe. Everywhere
    // else (the chat field) the webview keeps its own menu.
    this.islandEl.addEventListener("contextmenu", (e) => {
      if (this.isBotHit(e.clientX, e.clientY)) e.preventDefault();
    });

    // Dragging Nubo out of the island puts him on the desktop.
    window.addEventListener("mousemove", (e) => {
      if (this.desktop.carrying) {
        this.desktop.carry(e.clientX, e.clientY);
        return;
      }
      const press = this.botPress;
      if (!press) return;
      if (!(e.buttons & 1)) {
        this.botPress = null;
        return;
      }
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_THRESHOLD) return;
      this.botPress = null;
      if (!this.canDragOut()) return;
      this.cancelBotHover();
      this.desktop.pickUp(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", (e) => {
      this.botPress = null;
      if (this.desktop.carrying) this.desktop.carryEnd(e.clientX, e.clientY);
    });

    // Only keys typed into the island itself land here, never Escape typed in
    // a terminal — so it may fold a waiting card away, as Escape in the notch
    // does on macOS.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.dockMoving) {
        this.interruptDockMove();
        return;
      }
      if (e.key === "Escape" && State.mode === "expanded") {
        if (State.pendingApproval) this.foldApproval();
        else if (!State.isPinned) this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e), () => !State.paused && !State.shelfDragging);

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Pointer on/off the island as the compositor sees it (Linux only). Null
   * until the first report, so a platform that never sends it is not gated.
   */
  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    // WebKitGTK can deliver a mousemove after the pointer has left the layer
    // surface; trusting it re-enters the island and the auto-close never runs.
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    if (this.dockMoving) return;
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (State.fileDragOver && !UploadSeq.dropped) {
      if (UploadSeq.isActive) UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
      this.updateDropTarget(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    // Recorded before the state machine hears of it: a transition it makes
    // right away (open on hover) reads where the pointer is, and must not see
    // the pointer as still outside.
    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    if (inIsland && !wasIn) {
      if (this.fsm.state === "nubo") this.greeting.hover();
      this.fsm.mouseEntered();
    }
    if (!inIsland && wasIn) {
      this.fsm.mouseLeft();
    }
    if (inIsland !== wasIn) this.updateCountdown(performance.now());

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  /** The greeting and the drop sequence draw a Nubo of their own: not that one. */
  private canDragOut(): boolean {
    if (State.mode === "hidden" || !this.desktop.canPickUp()) return false;
    return !(State.mode === "expanded" && (State.view === "greeting" || this.uploadActive));
  }

  private isBotHit(x: number, y: number): boolean {
    // Out on the desktop, the island's Nubo is invisible: nothing to hit.
    if (State.nuboOnDesktop || (this.lateral && State.mode === "expanded" && !this.lateralAvatar())) return false;
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (this.greetingCanvas.width !== Math.round(EXPANDED_W * dpr)) {
          this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
          this.greetingCanvas.height = Math.round(150 * dpr);
        }
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Nubo
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    // A file over the drop card: the sessions it could go to, on the right.
    const listing = (uploadActive || this.lateral) && State.view === "upload" && State.fileDragOver && !UploadSeq.dropped;
    const dropParent = this.lateral ? this.views.get("upload")?.el : this.uploadCanvas.el;
    if (dropParent && this.sessionDrop.el.parentElement !== dropParent) dropParent.append(this.sessionDrop.el);
    this.sessionDrop.sync(listing);
    this.uploadCanvas.textRight = listing && dropTargets(State.tasks).length > 0 ? DROP_TEXT_RIGHT_WITH_LIST : this.uploadCanvas.defaultTextRight;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    // A ticker scroll that loses its frames freezes mid-way, rows overlapping.
    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const botMoving = !this.botCx.settled || !this.botCy.settled || !this.botSize.settled;
    // Closed, only the folding — and Nubo reaching his place in the closed island.
    const busy = State.mode === "hidden"
      ? settling || (closedIsland(State.settings.closedIsland) === "nubo" &&
        (botMoving || nowMs < this.closedAwakeUntil))
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive || viewAnimating;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const shelfVisible = State.view === "upload" && (State.shelfFiles.length > 0 || State.shelfError);
    let p = botPosition(State.mode, shelfVisible ? "choose" : State.view, this.height.value, State.uploadProgress);
    // The closed island with Nubo in it, as on a Mac without a notch.
    if (State.mode === "hidden" && closedIsland(State.settings.closedIsland) === "nubo") {
      p = { cx: this.width.value / 2, cy: this.height.value / 2, diameter: CLOSED_BOT_D, opacity: 1 };
    }
    if (this.lateral && State.mode === "compact") {
      const hasMinis = State.otherTasks.length > 0;
      const clock = State.settings.showClock;
      this.islandEl.style.setProperty("--side-clock-y", hasMinis ? "49%" : "73%");
      const center = hasMinis ? clock ? 0.23 : 0.27 : clock ? 0.3 : 0.5;
      p = { cx: this.width.value / 2, cy: this.height.value * center + 4, diameter: 22, opacity: 1 };
    }
    const avatar = this.lateralAvatar();
    if (avatar) {
      const x = avatar.offsetLeft + (document.documentElement.dataset.dir === "rtl" ? avatar.offsetWidth - 35 : 35);
      p = { cx: this.viewsEl.offsetLeft + x, cy: this.viewsEl.offsetTop + avatar.offsetTop + avatar.offsetHeight / 2, diameter: 40, opacity: 1 };
    }
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Nubo; two of them would overlap. Out on the
    // desktop, he isn't here at all.
    const away = State.nuboOnDesktop || this.sideLyricsCompact() || this.lateral && State.mode === "expanded" && !avatar;
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive && !away;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive && !away) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private lateralAvatar() {
    if (!this.lateral || State.mode !== "expanded") return null;
    if (State.view === "approval" || State.view === "question") {
      return this.views.get(State.view)?.el.firstElementChild as HTMLElement | null;
    }
    if (State.view !== "overview") return null;
    const overview = this.views.get("overview")?.el;
    return overview?.dataset.avatar === "true" ? overview.firstElementChild as HTMLElement : null;
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Drawn at the current ratio, so a bitmap sized for another monitor's
    // would show Nubo too big and cut, or too small.
    if (this.canvasPx !== w || this.canvasDpr !== dpr) {
      this.canvasPx = w;
      this.canvasDpr = dpr;
      this.botCanvas.width = Math.round(wCss * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${wCss}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - wCss / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    // A new Nubo waits: over an idle or sleeping Nubo, the blue and the arrow
    // badge (whats-new.ts). Anything Nubo has to say comes first.
    this.engine.setUpdateHint(this.updateHintOn() ? UPDATE_BLUE_RGB : null);
    // While a plan card is open Nubo wears the plan's colour, like its pill.
    this.engine.bodyColor = planCardOpen()
      ? hexToRGB(openPlanColor())
      : this.engine.showsUpdateHint
        ? UPDATE_BLUE_RGB
        : focus
          ? hexToRGB(focus.color)
          : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    // Only the main Nubo is dressed — the one of the main tool's pill (Settings →
    // Active pills): a focused integration pill shows its own colours, unless
    // the wardrobe is open (BotCanvasView.showOutfit, macOS).
    // In the wardrobe the hovered outfit swaps in at once, without the drop-in.
    const inWardrobe = State.mode === "expanded" && State.view === "wardrobe";
    const mainFocused = State.focusId == null || State.focusId === State.mainPillId;
    const showOutfit = mainFocused || State.mode !== "expanded" || inWardrobe;
    const outfit = State.wardrobePreview ?? this.seasons.get(parseOutfit(State.settings.nuboOutfit));
    this.engine.setOutfit(showOutfit ? outfit : "none", !inWardrobe);
    // Dances while music plays: always in the compact island, expanded only on
    // the music pill's card (BotCanvasView, macOS). Asked every frame.
    this.engine.setDancing(islandDances({
      music: State.spotifyPlaying,
      state: State.effectiveState,
      mode: State.mode,
      view: State.view,
      focusId: State.focusTask?.id,
    }));

    this.engine.update(dt);
    // Cleared in device pixels, the whole canvas. At a fractional scale (150 %)
    // the canvas is a whole number of pixels but `hCss * dpr` is not: clearing
    // in CSS units left the last row half-cleared, and whatever once passed
    // through it (a hat in a roll) piled up there into a coloured bar.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.botCanvas.width, this.botCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, BOT_SIDE * dpr, 0);
    ctx.save();
    this.engine.applyDance(ctx, w, hCss);
    this.engine.draw(ctx, w, hCss);
    ctx.restore();
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    // In the closed island the cursor isn't followed: he looks around by himself.
    if (State.mode === "hidden") return this.closedLook.x;
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    if (State.mode === "hidden") return this.closedLook.y;
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private countdownDueAt: number | null = null;
  private countdownAnimation: Animation | null = null;
  private countdownColor = "";

  private updateCountdown(nowMs: number) {
    const dueAt = State.mode === "expanded" && !this.fsm.pinned
      ? this.fsm.homeCollapseDueAt : null;
    if (dueAt !== this.countdownDueAt) {
      this.countdownDueAt = dueAt;
      this.countdownAnimation?.cancel();
      this.countdownAnimation = null;
      if (dueAt != null && dueAt > nowMs) {
        const remaining = dueAt - nowMs;
        const duration = this.fsm.homeCollapseDurationMs;
        const scale = clamp(remaining / duration, 0, 1);
        this.countdownAnimation = this.countdown.animate(
          [{ transform: "scaleX(" + scale + ")" }, { transform: "scaleX(0)" }],
          { duration: remaining, fill: "forwards" },
        );
      }
    }
    if (dueAt != null) {
      const state = BOT_STATES[State.effectiveState];
      const rgb = this.engine.bodyColor ?? (state.tint > 0 ? state.color : null);
      const color = rgb
        ? "rgb(" + rgb.map((channel) => Math.round(channel * 255)).join(" ") + ")"
        : "#8B7CF7";
      if (color !== this.countdownColor) {
        this.countdownColor = color;
        this.countdown.style.setProperty("--countdown-color", color);
      }
    }
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    const live = expanded && !greetingActive;
    this.contentEl.style.opacity = live ? "1" : "0";
    // While the drop sequence owns the body its buttons are painted on the canvas
    // underneath, so only the header may keep taking clicks up here.
    this.contentEl.style.pointerEvents = live && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    // Leaving the greeting, however it ends, lets its sound fade out.
    if (this.greetingShown && !greetingActive) this.greeting.leave();
    this.greetingShown = greetingActive;
    // A wardrobe try-on never outlives the wardrobe.
    if (State.wardrobePreview && !(expanded && State.view === "wardrobe")) State.wardrobePreview = null;

    const pendingReminder = hasPendingReminders();
    const showingPendingTasks = expanded && State.view === "tasks" && pendingReminder;
    if (this.showingPendingTasks && !showingPendingTasks && expanded && State.view === "tasks") {
      if (!this.restorePinnedLyrics() && !this.wasInIsland) {
        this.fsm.mouseLeft();
      }
    }
    this.showingPendingTasks = showingPendingTasks;
    this.reminderDot.hidden = State.mode !== "compact" || !pendingReminder;
    this.header.sync();
    const here = tabIndex(State.view);
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      // A view to the left of this one waits at the left, one to the right at
      // the right: changing tab pans from one to the other.
      const at = tabIndex(name);
      const rel = here >= 0 && at >= 0 ? Math.max(-1, Math.min(1, at - here)) : 0;
      view.el.style.setProperty("--rel", String(rel));
      if (on) view.sync();
    }

    // The chat and the launch card are the views with a text field, so they
    // are the only time the island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView != null && TYPING_VIEWS.has(this.lastSyncedView);
      this.lastSyncedView = State.view;
      if (TYPING_VIEWS.has(State.view)) {
        const view = State.view;
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get(view)?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    this.root.dataset.mode = State.mode;
    this.root.dataset.view = State.view;
    this.updateLyric();
    const gripParent = State.mode === "expanded" ? this.header.el : this.islandEl;
    if (this.dockGrip.parentElement !== gripParent) gripParent.append(this.dockGrip);
    this.dockGrip.hidden = HOST_OS !== "windows" || State.mode === "hidden" ||
      this.lyricShown || (this.lateral && !expanded) || State.view === "greeting" || this.uploadActive || State.pendingApproval != null;
    const sideLyrics = this.sideLyricsShowing();
    if (this.pinnedLyrics && !this.resumeLyrics && expanded && !sideLyrics &&
        State.view === "overview" && !State.pendingApproval) this.pinnedLyrics = false;
    this.sidePin.hidden = !sideLyrics;
    this.sidePin.classList.toggle("on", this.pinnedLyrics);
    this.sidePin.setAttribute("aria-pressed", String(this.pinnedLyrics));

    // Compact mini grid
    const showGrid = State.mode === "compact" && !this.sideLyricsCompact();
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
        this.applyGeometry();
      }
    }

    // Compact Claude plan indicator
    const showPlan = !this.lateral && !this.lyricShown && claudeCompactPillVisible();
    this.compactPlan.style.opacity = showPlan ? "1" : "0";
    this.compactPlan.style.pointerEvents = showPlan ? "auto" : "none";
    if (showPlan) {
      const others = State.otherTasks.slice(0, 4);
      this.compactPlan.style.right = others.length > 0 ? "58px" : "20px";
      // With nothing in the middle (no clock, no lyric) the gauge takes it.
      this.compactPlan.classList.toggle("mid", !this.lyricShown && !State.settings.showClock);
      const pct = dominantPct(State.planUsage);
      this.compactPlan.style.setProperty("--plan", CLAUDE_PLAN_COLOR);
      this.compactPlanLabel.textContent = pct != null ? `${Math.round(pct)}%` : "—";
    }

    this.updateClock();
    this.syncPanelSize();

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  /** The clock sits in the middle of the compact island, where the notch is on a Mac. */
  private updateClock() {
    this.updateClosed();
    this.updateLyric();
    const on = State.mode === "compact" && State.settings.showClock && !this.lyricShown && !this.sideLyricsCompact();
    this.clockEl.style.opacity = on ? "1" : "0";
    if (!on) return;
    const now = new Date();
    const date = now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const text = this.lateral ? time : `${date}  ${time}`;
    if (this.clockEl.textContent !== text) this.clockEl.textContent = text;
  }

  private lyricShown = false;
  private lyricTarget = "";
  /** Width the compact island takes to fit the line (0 = the usual compact width). */
  private lyricW = 0;
  private lyricSwap?: number;

  /** A width for `text`, in steps of 40 px so the island does not twitch at every word. */
  private lyricWidthFor(text: string): number {
    if (text === "" || text === "♪") return 0;
    this.lyricProbe.textContent = text;
    const need = this.lyricProbe.getBoundingClientRect().width + 2 * this.lyricEl.offsetLeft + 28;
    return clamp(Math.ceil(need / 40) * 40, COMPACT_W + 72, 600);
  }

  /** The line, or — when the song has none — five bars dancing, as a sound meter. */
  private setLyricLabel(span: HTMLElement, label: string) {
    const bars = label === "♪";
    span.classList.toggle("eq", bars);
    if (!bars) {
      this.stopEq();
      span.classList.remove("fallback");
      span.textContent = label;
      return;
    }
    span.classList.remove("fallback");
    span.textContent = "";
    for (let i = 0; i < 5; i++) {
      const bar = document.createElement("i");
      bar.style.setProperty("--d", `${-i * 0.17}s`);
      span.append(bar);
    }
    this.startEq(span);
  }

  private eqTimer?: number;
  private eqLevel = 0;
  private eqBusy = false;

  /**
   * The bars follow Spotify's loudness (its peak in the Windows mixer, read ten
   * times a second): they rise at once and fall away. Where the level cannot be
   * read they dance on their own (`fallback`).
   */
  private startEq(span: HTMLElement) {
    this.stopEq();
    const weights = [0.62, 0.9, 1, 0.82, 0.66];
    this.eqTimer = window.setInterval(() => {
      if (this.eqBusy) return;
      this.eqBusy = true;
      void Bridge.spotifyLevel().then((level) => {
        this.eqBusy = false;
        if (!span.isConnected || !span.classList.contains("eq")) return;
        if (level == null) {
          span.classList.add("fallback");
          this.stopEq();
          return;
        }
        // Peaks of music sit well under 1: lifted so a normal volume fills the bars.
        const lifted = Math.min(1, Math.pow(level, 0.6) * 1.25);
        this.eqLevel = Math.max(lifted, this.eqLevel * 0.78);
        const bars = span.children;
        for (let i = 0; i < bars.length; i++) {
          const wobble = 0.72 + 0.28 * Math.random();
          const h = 4 + 13 * Math.min(1, this.eqLevel * weights[i] * wobble * 1.15);
          (bars[i] as HTMLElement).style.height = `${h.toFixed(1)}px`;
        }
      });
    }, 90);
  }

  private stopEq() {
    if (this.eqTimer != null) window.clearInterval(this.eqTimer);
    this.eqTimer = undefined;
    this.eqBusy = false;
    this.eqLevel = 0;
  }

  private paintSideLyrics() {
    const lines = currentLyrics();
    const track = this.sideLyricTrack;
    const previous = this.sideLyricIndex;
    const changed = lines !== this.sideLyricSource;
    if (changed) {
      this.sideLyricSource = lines;
      track.replaceChildren(...(lines ?? []).map((line) => h("div", {}, h("span", { text: line.text || "♪" }))));
    }
    this.sideLyricEmpty.hidden = !!lines;
    if (!lines) {
      this.sideLyricEmpty.textContent = lyricsLoading() ? t("Loading lyrics…") : t("Lyrics not available");
      this.sideLyricIndex = -2;
      return;
    }
    const index = currentLyricWindow()?.index ?? -1;
    this.sideLyricIndex = index;
    if (changed || index !== previous) {
      for (const [i, row] of Array.from(track.children).entries()) {
        row.classList.toggle("current", i === index);
        row.classList.toggle("near", Math.abs(i - index) === 1);
      }
    }
    const row = track.children[Math.max(0, index)] as HTMLElement | undefined;
    if (!row) return;
    const y = this.sideLyricsEl.clientHeight / 2 - row.offsetTop - row.offsetHeight / 2;
    const transform = `translateY(${y}px)`;
    if (track.style.transform !== transform) {
      const advance = !changed && previous >= 0 && index === previous + 1;
      track.style.transition = advance ? "" : "none";
      track.style.transform = transform;
    }
  }

  /**
   * Spotify lyrics (the bubble button of the Spotify card). While a song plays, the compact
   * island shows the line being sung — a second early — where the clock goes,
   * grows to fit it, leaving room for the other pills; a ♪
   * stands in while there is no line. Lines cross-fade rather than jump.
   */
  private updateLyric() {
    const mode = this.compactLyrics();
    const side = this.sideLyricsCompact();
    this.sideLyricsEl.hidden = !side;
    if (side) this.paintSideLyrics();
    const current = mode ? (currentLyricWindow()?.current ?? "") : "";
    const label = mode ? (current !== "" ? current : "♪") : "";
    this.lyricShown = mode;
    this.lyricEl.style.opacity = mode ? "1" : "0";
    if (label !== this.lyricTarget) {
      this.lyricTarget = label;
      const span = this.lyricSpan;
      if (this.lyricSwap != null) window.clearTimeout(this.lyricSwap);
      if (!span.textContent && span.childElementCount === 0 || !mode) {
        this.setLyricLabel(span, label);
        span.classList.remove("swap");
      } else {
        span.classList.add("swap");
        this.lyricSwap = window.setTimeout(() => {
          this.setLyricLabel(span, label);
          span.classList.remove("swap");
          this.lyricSwap = undefined;
        }, 160);
      }
    }
    const w = mode ? this.lyricWidthFor(label) : 0;
    if (w !== this.lyricW) {
      const grew = w > this.lyricW;
      this.lyricW = w;
      if (State.mode === "compact") this.animateGeometry(!grew);
    }
    if ((mode || side) && this.lyricTimer == null) {
      this.lyricTimer = window.setInterval(() => this.updateLyric(), 250);
    } else if (!mode && !side && this.lyricTimer != null) {
      window.clearInterval(this.lyricTimer);
      this.lyricTimer = undefined;
    }
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    // The closed island may have changed: what it shows, or whether it shows.
    this.closedKey = "";
    this.updateClosed();
    if (State.mode === "hidden") {
      this.animateGeometry(true);
      if (this.collapsed) this.sendCollapsedSize();
    }
    this.scheduleClosedLife();
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    // The clock fills the island's middle: its width follows the setting.
    if (State.mode === "compact") this.animateGeometry(this.targetSize().w < this.width.value);
    State.notify();
    // ponytail: one timer for the life of the window; a minute is the clock's finest tick.
    this.clockTimer ??= window.setInterval(() => this.updateClock(), 10_000);
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
