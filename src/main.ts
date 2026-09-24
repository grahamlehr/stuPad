import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import type { Deck, KioskConfig, LogEvent } from './types';
import { loadDeck, loadConfig, getKioskState, setKioskState, appendEvent, requestPersistence } from './store';
import { KioskController } from './kiosk';
import { SetupScreen } from './ui/setup';
import { AdminPanel } from './ui/admin';
import { PinPad } from './ui/pinpad';
import { decideStartupScreen } from './ui/lifecycle';
import { isoLocal } from './util';

type Screen = 'setup' | 'kiosk';

class App {
  private readonly appRoot: HTMLElement;
  private readonly kioskRoot: HTMLElement;

  private deck: Deck | undefined;
  private config: KioskConfig | undefined;
  private sessionId: string | null = null;

  private screen: Screen = 'setup';
  private controller: KioskController | null = null;
  private setupScreen: SetupScreen | null = null;
  private adminPanel: AdminPanel | null = null;
  private adminOverlayEl: HTMLElement | null = null;
  private pinPad: PinPad | null = null;

  constructor() {
    this.appRoot = document.getElementById('app')!;
    this.kioskRoot = document.createElement('div');
    this.kioskRoot.className = 'kiosk-root';
    this.kioskRoot.style.display = 'none';
    document.body.appendChild(this.kioskRoot);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.screen === 'kiosk') {
        this.log({ event: 'app_resume' });
      }
    });
  }

  async init(): Promise<void> {
    registerSW({ immediate: true });
    void requestPersistence();

    this.deck = await loadDeck();
    this.config = await loadConfig();
    const state = await getKioskState();

    if (decideStartupScreen(state) === 'kiosk' && this.deck && this.config && state.sessionId) {
      this.sessionId = state.sessionId;
      await this.enterKiosk();
      this.log({ event: 'app_resume' });
    } else {
      this.showSetup();
    }
  }

  // ------------------------------------------------------------- logging

  private log(e: Omit<LogEvent, 'ts' | 'session_id'>): void {
    if (!this.sessionId) return;
    const full: LogEvent = { ...e, ts: isoLocal(), session_id: this.sessionId };
    // Never await on the tap path; report failures without blocking kiosk input.
    void appendEvent(full).catch((err) => {
      console.error('stuPad: failed to log event', err);
    });
  }

  // -------------------------------------------------------------- setup

  private showSetup(): void {
    this.screen = 'setup';
    this.kioskRoot.style.display = 'none';
    this.appRoot.innerHTML = '';
    window.scrollTo(0, 0);
    const container = document.createElement('div');
    this.appRoot.appendChild(container);
    this.setupScreen = new SetupScreen({
      container,
      initialDeck: this.deck,
      initialConfig: this.config,
      onGoLive: (deck, config, sessionId) => void this.goLive(deck, config, sessionId),
    });
    void this.setupScreen.refreshStorageInfo();
  }

  private async goLive(deck: Deck, config: KioskConfig, sessionId: string): Promise<void> {
    this.deck = deck;
    this.config = config;
    this.sessionId = sessionId;
    await setKioskState({ running: true, sessionId, startedAt: isoLocal() });
    this.log({ event: 'kiosk_start' });
    this.setupScreen?.destroy();
    this.setupScreen = null;
    await this.enterKiosk();
  }

  // -------------------------------------------------------------- kiosk

  private async enterKiosk(): Promise<void> {
    if (!this.deck || !this.config || !this.sessionId) return;
    this.screen = 'kiosk';
    this.appRoot.innerHTML = '';
    this.kioskRoot.style.display = 'block';
    this.kioskRoot.innerHTML = '';
    // The Setup screen can be a long scrolling page; reset scroll so the now-fixed
    // kiosk root isn't visually displaced by leftover elastic overscroll (iOS Safari).
    window.scrollTo(0, 0);

    // SlideStage forces `position: relative` (inline) on the container it's given, which
    // would clobber kioskRoot's own `position: fixed` (CSS) if passed directly. Give
    // KioskController an inner host instead; kioskRoot itself stays the fixed, full-viewport
    // shell (also used by the PIN pad / admin overlays, which sit on top of it).
    const stageHost = document.createElement('div');
    stageHost.style.width = '100%';
    stageHost.style.height = '100%';
    this.kioskRoot.appendChild(stageHost);

    this.controller = new KioskController({
      root: stageHost,
      deck: this.deck,
      config: this.config,
      sessionId: this.sessionId,
      log: (e) => this.log(e),
      onAdminRequested: () => this.requestAdmin(),
    });
    await this.controller.start();
  }

  private requestAdmin(): void {
    if (!this.config) return;
    if (this.config.adminPin) {
      this.pinPad = new PinPad(this.kioskRoot, {
        pin: this.config.adminPin,
        onSuccess: () => {
          this.pinPad = null;
          this.showAdmin();
        },
        onFail: () => this.log({ event: 'admin_unlock_fail' }),
        onGiveUp: () => {
          this.pinPad = null;
        },
      });
    } else {
      this.showAdmin();
    }
  }

  // -------------------------------------------------------------- admin

  private showAdmin(): void {
    if (!this.deck || !this.config || !this.sessionId) return;
    const container = document.createElement('div');
    container.className = 'admin-overlay';
    this.kioskRoot.appendChild(container);
    this.adminOverlayEl = container;
    this.adminPanel = new AdminPanel({
      container,
      deck: this.deck,
      config: this.config,
      sessionId: this.sessionId,
      onResume: () => this.closeAdmin(),
      onSetup: () => void this.exitToSetup(),
    });
  }

  private closeAdmin(): void {
    this.adminPanel?.destroy();
    this.adminPanel = null;
    this.adminOverlayEl?.remove();
    this.adminOverlayEl = null;
  }

  private async exitToSetup(): Promise<void> {
    this.log({ event: 'kiosk_stop' });
    this.pinPad?.destroy();
    this.pinPad = null;
    this.closeAdmin();
    this.controller?.stop();
    this.controller = null;
    await setKioskState({ running: false, sessionId: null, startedAt: null });
    this.sessionId = null;
    this.showSetup();
  }
}

void new App().init();
